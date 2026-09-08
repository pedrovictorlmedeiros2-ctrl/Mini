/**
 * SERVICE READINESS GATE
 *
 * Estado global do serviço, separado da decisão por-bot que
 * `SandboxManager.decideBackend()` já faz. A diferença importa: hoje, sem
 * isto, um host sem isolamento forte só descobre isso quando ALGUÉM tenta
 * subir um bot (o erro aparece ali, por bot, fail-closed — o que já está
 * correto). O que faltava é uma pergunta de nível de SERVIÇO, respondível
 * ANTES de qualquer tentativa: "este host está pronto pra hospedar hoje?" —
 * pra health check, pra decidir se o provisionamento deve nem começar, e
 * pra deixar isso visível num único lugar em vez de espalhado.
 *
 * Três estados, nunca mais que isso:
 *   READY    — tudo que produção exige está disponível.
 *   DEGRADED — o serviço pode hospedar bots normalmente, mas algo auxiliar
 *              (não obrigatório pra segurança) está faltando — ex: sem
 *              canal de alerta administrativo configurado.
 *   BLOCKED  — isolamento forte é exigido (produção) e não está
 *              disponível. NUNCA cai pro backend reduzido silenciosamente
 *              pra compensar — ver assertProvisioningAllowed().
 *
 * Isto NUNCA decide sozinho classificar um bot como malicioso nem participa
 * do Kamikaze — é só um gate de "este host pode operar hospedagem agora",
 * ortogonal ao SecurityEngine.
 */
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { detectCapabilities } = require('./sandbox/capabilityDetector');

const STATUS = Object.freeze({ READY: 'READY', DEGRADED: 'DEGRADED', BLOCKED: 'BLOCKED' });

// Default de arranque é BLOCKED, de propósito — fail-closed: antes da
// primeira computeReadiness() rodar de verdade (é assíncrona, chamada uma
// vez no boot), NUNCA se assume READY por omissão. Uma janela pequena onde
// o serviço nega provisionamento é sempre mais segura do que uma janela
// (por menor que seja) onde ele libera sem ter checado nada ainda.
let state = {
    status: STATUS.BLOCKED,
    blockedReasons: ['Estado de prontidão ainda não verificado (aguardando a primeira computeReadiness() do boot).'],
    degradedReasons: [],
    checkedAt: null,
};

let recheckTimer = null;

/**
 * Produção exige isolamento forte por padrão (NODE_ENV=production). Pode
 * ser forçado explicitamente pros dois lados (útil em dev/CI, ou num host
 * de produção atípico) via REQUIRE_LINUX_SANDBOX=true|false — explícito
 * sempre vence o padrão implícito de NODE_ENV.
 */
function isProductionIsolationRequired() {
    const override = process.env.REQUIRE_LINUX_SANDBOX;
    if (override === 'true') return true;
    if (override === 'false') return false;
    return process.env.NODE_ENV === 'production';
}

function isDirWritable(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probePath = path.join(dir, `.write-test-${process.pid}-${Date.now()}`);
        fs.writeFileSync(probePath, 'x');
        fs.unlinkSync(probePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Recalcula o estado do zero. Chamado no boot, e periodicamente depois
 * (ver startReadinessMonitor) — NUNCA a cada request de /health, porque
 * detectCapabilities() faz testes funcionais reais (cria e destrói tabela
 * nftables, par veth, etc.) e não é barato repetir a cada poucos segundos.
 *
 * @returns {Promise<typeof state>}
 */
async function computeReadiness() {
    const blockedReasons = [];
    const degradedReasons = [];

    // ── Isolamento forte obrigatório em produção ────────────────────────
    if (isProductionIsolationRequired()) {
        const caps = detectCapabilities();
        if (!caps.linuxSandboxReady) {
            blockedReasons.push(
                `Isolamento Linux forte é obrigatório em produção (NODE_ENV=production ou REQUIRE_LINUX_SANDBOX=true), ` +
                `mas não está disponível neste host: ${caps.linuxSandboxBlockedBy.join(' | ')}`
            );
        }
    }

    // ── Diretórios essenciais precisam existir e ser graváveis ──────────
    // Sem isto, bots não sobem, backups não salvam, e o Kamikaze não
    // consegue quarentenar — tratado como bloqueante independente do modo
    // (não é uma questão de isolamento, é uma questão de o serviço
    // conseguir operar de forma correta).
    const requiredDirs = [
        ['bots', config.system.botsFolder],
        ['backups', config.system.backupsFolder],
        ['quarentena', config.system.quarantineFolder],
        ['logs', config.system.logsFolder],
    ];
    for (const [label, dir] of requiredDirs) {
        if (!isDirWritable(path.resolve(dir))) {
            blockedReasons.push(`Diretório de ${label} não existe ou não é gravável: ${dir}`);
        }
    }

    // ── Auxiliares: não bloqueiam hospedagem, mas reduzem observação ────
    if (!process.env.LOG_WEBHOOK_URL) {
        degradedReasons.push(
            'LOG_WEBHOOK_URL não configurado — alertas administrativos (Kamikaze, crash, limite de recurso) ' +
            'não chegam a nenhum canal do staff, só a DM do dono do bot.'
        );
    }

    try {
        const containerMgr = require('./containerManager');
        if (containerMgr.containersEnabled()) {
            const dockerOk = await containerMgr.isDockerAvailable();
            if (!dockerOk) {
                degradedReasons.push(
                    'USE_CONTAINERS=true, mas o Docker não está disponível neste host — bots que dependem ' +
                    'do backend de container não conseguem iniciar (bots que usam o SandboxManager continuam normais).'
                );
            }
        }
    } catch (err) {
        degradedReasons.push(`Não foi possível checar a disponibilidade do Docker: ${err.message}`);
    }

    let status = STATUS.READY;
    if (blockedReasons.length) status = STATUS.BLOCKED;
    else if (degradedReasons.length) status = STATUS.DEGRADED;

    state = { status, blockedReasons, degradedReasons, checkedAt: new Date().toISOString() };
    return state;
}

/** Leitura barata do último estado calculado — não recomputa nada. */
function getReadinessState() {
    return state;
}

/**
 * Ponto único de aplicação do gate. Lança (fail-closed) se o serviço
 * estiver BLOCKED — quem chama decide o que fazer com o erro (processManager
 * e dependencyManager usam isso pra recusar start/instalação).
 *
 * @param {string} action - descrição curta da operação recusada, pro log/erro
 */
function assertProvisioningAllowed(action = 'operação de provisionamento') {
    if (state.status === STATUS.BLOCKED) {
        throw new Error(
            `Serviço em estado BLOCKED — ${action} recusada por segurança (fail-closed, sem fallback pro backend reduzido). ` +
            `Motivo(s): ${state.blockedReasons.join(' | ')}`
        );
    }
}

/**
 * Recalcula periodicamente (não em cada request) e loga quando o status
 * MUDA — útil operacionalmente (ex: notar que o host virou BLOCKED depois
 * de uma falha de disco, ou que voltou a READY depois de corrigido).
 */
function startReadinessMonitor(intervalMs = 5 * 60 * 1000) {
    if (recheckTimer) clearInterval(recheckTimer);
    recheckTimer = setInterval(async () => {
        const previousStatus = state.status;
        try {
            await computeReadiness();
        } catch (err) {
            console.error('[ServiceReadiness] Falha ao recalcular o estado:', err.message);
            return;
        }
        if (state.status !== previousStatus) {
            console.warn(`[ServiceReadiness] Estado mudou de ${previousStatus} para ${state.status}.`, state);
        }
    }, intervalMs);
    if (recheckTimer.unref) recheckTimer.unref();
}

function stopReadinessMonitor() {
    if (recheckTimer) {
        clearInterval(recheckTimer);
        recheckTimer = null;
    }
}

module.exports = {
    STATUS,
    computeReadiness,
    getReadinessState,
    assertProvisioningAllowed,
    isProductionIsolationRequired,
    startReadinessMonitor,
    stopReadinessMonitor,
};
