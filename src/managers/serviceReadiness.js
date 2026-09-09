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
const alertManager = require('./alertManager');
const clientRef = require('../utils/clientRef');

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
 * FASE 9 (hardening): alerta proativo em mudança de estado — antes disso,
 * uma transição pra BLOCKED/DEGRADED só aparecia em console.warn(), então
 * o serviço podia parar de provisionar (assertProvisioningAllowed()) sem
 * NINGUÉM ser avisado até alguém notar manualmente.
 *
 * Manda pros DOIS canais quando disponíveis (webhook `sendAlert()` E DM
 * `tryDM()` pro owner do painel) — nunca um com fallback pro outro,
 * porque o motivo mais comum de DEGRADED hoje é justamente
 * LOG_WEBHOOK_URL ausente: um alerta que dependesse só do webhook nunca
 * avisaria sobre a falta do próprio webhook. Cada canal tem seu próprio
 * try/catch — a falha de um nunca impede o outro, e nenhum dos dois pode
 * nunca propagar pra fora (chamado de dentro de computeReadiness(), que
 * precisa continuar funcionando mesmo com Discord/webhook fora do ar).
 *
 * Nunca alerta se o status não mudou (evita spam a cada recheck
 * periódico) nem no primeiro computeReadiness() da vida do processo se o
 * resultado for READY (primeiro check bem-sucedido não é notícia — mas
 * um primeiro check revelando DEGRADED/BLOCKED É, por isso alerta nesse
 * caso mesmo sendo "o primeiro").
 */
function maybeAlertReadinessChange(previous, next) {
    // O placeholder de arranque também tem status BLOCKED (fail-closed) —
    // por isso "é a primeira checagem de verdade" só pode ser decidido
    // por `checkedAt === null`, NUNCA por comparar `status`: se comparasse
    // por status, um primeiro computeReadiness() que realmente resultasse
    // em BLOCKED seria mascarado como "sem mudança" (placeholder BLOCKED
    // === resultado real BLOCKED) e nunca alertaria — exatamente o oposto
    // do que "primeiro check revelando um problema real" deveria fazer.
    const isFirstRealCheck = previous.checkedAt === null;
    if (isFirstRealCheck) {
        if (next.status === STATUS.READY) return; // primeiro check bem-sucedido não é notícia
    } else if (previous.status === next.status) {
        return; // sem mudança de verdade (nunca do placeholder) — evita spam
    }

    const severityByStatus = { READY: 'success', DEGRADED: 'warning', BLOCKED: 'error' };
    const reasons = [...next.blockedReasons, ...next.degradedReasons];
    const title = `[Atlantic Host] Prontidão do serviço: ${previous.status} → ${next.status}`;
    const message = reasons.length ? reasons.join('\n') : 'Nenhum motivo listado (READY).';

    console.warn(`[ServiceReadiness] Estado mudou de ${previous.status} para ${next.status}.`, next);

    // sendAlert()/tryDM() já nunca lançam nem rejeitam por si (ambos têm
    // seu próprio try/catch interno) — o try/catch síncrono aqui e o
    // .catch() na Promise são só defesa em profundidade, pra nunca
    // depender disso continuar verdade nessas duas funções pra sempre.
    try {
        Promise.resolve(alertManager.sendAlert(title, message, severityByStatus[next.status] || 'info'))
            .catch((err) => console.error('[ServiceReadiness] Falha ao enviar alerta via webhook:', err.message));
    } catch (err) {
        console.error('[ServiceReadiness] Falha ao enviar alerta via webhook:', err.message);
    }

    try {
        const ownerId = config.bot && config.bot.ownerId;
        if (ownerId) {
            Promise.resolve(clientRef.tryDM(ownerId, `⚠️ **${title}**\n${message}`))
                .catch((err) => console.error('[ServiceReadiness] Falha ao tentar DM de alerta ao owner:', err.message));
        }
    } catch (err) {
        console.error('[ServiceReadiness] Falha ao tentar DM de alerta ao owner:', err.message);
    }
}

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

    // ── Groq (analisador auxiliar, Fase 2) indisponível por muito tempo ──
    // NUNCA bloqueia hospedagem — é só um sinal operacional pro admin. Só
    // conta como degradação se o operador OPTOU por ligar o Groq (habilitado
    // + GROQ_API_KEY configurada) e mesmo assim as últimas chamadas
    // operacionais estão falhando em sequência (ver SecurityMonitor.js —
    // "desabilitado"/"sem chave" nunca incrementam esse contador). O
    // Kamikaze determinístico (SecurityEngine/IncidentResponseManager)
    // continua funcionando de forma idêntica independente disto.
    try {
        const { getGroqMonitorHealth } = require('./security/monitor/SecurityMonitor');
        const cfg = config.security.groqMonitor;
        if (cfg.enabled && process.env.GROQ_API_KEY) {
            const health = getGroqMonitorHealth();
            if (health.consecutiveUnavailable >= cfg.degradedAfterConsecutiveFailures) {
                degradedReasons.push(
                    `Analisador auxiliar Groq indisponível nas últimas ${health.consecutiveUnavailable} tentativas operacionais ` +
                    `seguidas (último sucesso: ${health.lastAvailableAt || 'nunca'}) — o Kamikaze determinístico continua ` +
                    `funcionando normalmente, só a sugestão auxiliar do Groq está fora do ar.`
                );
            }
        }
    } catch (err) {
        degradedReasons.push(`Não foi possível checar a saúde do SecurityMonitor/Groq: ${err.message}`);
    }

    let status = STATUS.READY;
    if (blockedReasons.length) status = STATUS.BLOCKED;
    else if (degradedReasons.length) status = STATUS.DEGRADED;

    const previous = state;
    state = { status, blockedReasons, degradedReasons, checkedAt: new Date().toISOString() };
    maybeAlertReadinessChange(previous, state);
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
 * Recalcula periodicamente (não em cada request) — a detecção de mudança
 * de estado e o alerta (log + webhook + DM) vivem dentro de
 * computeReadiness()/maybeAlertReadinessChange(), pra cobrir tanto este
 * recheck periódico quanto a primeira chamada feita no boot (antes deste
 * monitor sequer existir) com a mesma lógica, num único lugar.
 */
function startReadinessMonitor(intervalMs = 5 * 60 * 1000) {
    if (recheckTimer) clearInterval(recheckTimer);
    recheckTimer = setInterval(async () => {
        try {
            await computeReadiness();
        } catch (err) {
            console.error('[ServiceReadiness] Falha ao recalcular o estado:', err.message);
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
    _maybeAlertReadinessChange: maybeAlertReadinessChange,
};
