/**
 * SECURITY ENGINE (Kamikaze Mode) — ponto único de ingestão de sinais de
 * segurança e classificador de severidade.
 *
 * Não existe nenhuma heurística de "pontuação livre" ou ML aqui de
 * propósito — a tabela de regras é pequena, explícita e enumerada, porque
 * uma decisão CRITICAL aciona destruição/reconstrução de estado (parar o
 * bot, mover a pasta pra quarentena, restaurar backup, revogar
 * credenciais). Duas vias, e só duas, levam a CRITICAL:
 *
 *   (a) uma evidência "dura" (HARD_EVIDENCE_CODES) — um match determinístico
 *       contra algo que nunca acontece numa execução legítima (ex.: o bot
 *       tentando ler o .env/banco real da plataforma). Um único evento já
 *       é suficiente, porque não é uma inferência de comportamento, é uma
 *       constatação de fato.
 *   (b) correlação de DUAS categorias de sinal independentes, cada uma já
 *       em HIGH (repetida várias vezes dentro da janela de correlação),
 *       pro MESMO bot. Uma categoria sozinha, não importa quantas vezes se
 *       repita, nunca escala sozinha além de HIGH.
 *
 * Isso é o requisito explícito de "não apagar arquivos baseado numa única
 * heurística" — CRITICAL sempre exige ou certeza, ou duas fontes
 * independentes concordando.
 *
 * SUSPICIOUS/HIGH nunca restringem ou destroem nada — só aumentam
 * observação (SUSPICIOUS) ou alertam sem parar o bot (HIGH). Só CRITICAL
 * aciona o IncidentResponseManager (Kamikaze completo).
 */
const config = require('../../../config');
const { recordAuditEvent } = require('../auditManager');
const { sendAlert, notifyBotOwner } = require('../alertManager');

const SEVERITY = Object.freeze({
    SUSPICIOUS: 'SUSPICIOUS',
    HIGH: 'HIGH',
    CRITICAL: 'CRITICAL',
});

// Categoria de cada código de sinal conhecido. Um código fora deste mapa
// cai em 'unknown' — ainda é registrado, mas nunca correlaciona pra
// CRITICAL sozinho (evita que uma fonte nova/mal-testada vire gatilho de
// destruição sem revisão explícita desta tabela).
const SIGNAL_CATEGORY = Object.freeze({
    banned_module_blocked: 'sandbox_bypass',
    banned_binding_blocked: 'sandbox_bypass',
    symlink_escape_blocked: 'sandbox_bypass',
    path_escape_blocked: 'sandbox_bypass',
    platform_secret_path_blocked: 'sandbox_bypass',
    pids_ceiling: 'resource_abuse',
    oom_kill: 'resource_abuse',
});

// Evidência dura: um único evento já é CRITICAL, sem precisar de repetição
// nem correlação com outra categoria.
const HARD_EVIDENCE_CODES = new Set(['platform_secret_path_blocked']);

// botId -> [{ code, category, ts }] — só o suficiente pra correlacionar
// dentro da janela configurada. Não é persistido (o audit_log é a fonte
// permanente; isto é só o estado de trabalho da correlação).
const signalHistory = new Map();

function pruneOld(history, windowMs) {
    const cutoff = Date.now() - windowMs;
    while (history.length && history[0].ts < cutoff) history.shift();
}

function classify(botId, code) {
    const cfg = config.security.kamikaze;
    const category = SIGNAL_CATEGORY[code] || 'unknown';
    const now = Date.now();

    if (!signalHistory.has(botId)) signalHistory.set(botId, []);
    const history = signalHistory.get(botId);
    pruneOld(history, cfg.correlationWindowMs);
    history.push({ code, category, ts: now });

    if (HARD_EVIDENCE_CODES.has(code)) {
        return { severity: SEVERITY.CRITICAL, rule: 'hard_evidence', evidence: [{ code, category, ts: now }] };
    }

    const codeCounts = new Map();
    for (const h of history) {
        codeCounts.set(h.code, (codeCounts.get(h.code) || 0) + 1);
    }

    const sameCodeCount = codeCounts.get(code) || 0;
    if (sameCodeCount < cfg.highThresholdCount) {
        return { severity: SEVERITY.SUSPICIOUS, rule: 'single_occurrence', evidence: [{ code, category, ts: now }] };
    }

    // Este código já bateu o teto de repetição (HIGH). Verifica se ALGUMA
    // OUTRA categoria também já bateu o teto dentro da mesma janela —
    // correlação exige categorias DIFERENTES, nunca a mesma duas vezes.
    const highCategories = new Set();
    for (const [c, count] of codeCounts.entries()) {
        if (count >= cfg.highThresholdCount) highCategories.add(SIGNAL_CATEGORY[c] || 'unknown');
    }
    highCategories.delete('unknown'); // 'unknown' nunca participa de correlação

    if (highCategories.size >= 2) {
        return {
            severity: SEVERITY.CRITICAL,
            rule: 'correlated_high',
            evidence: history.filter((h) => highCategories.has(h.category)),
        };
    }

    return { severity: SEVERITY.HIGH, rule: 'repeated_signal', evidence: history.filter((h) => h.code === code) };
}

/**
 * Ponto único de ingestão. Qualquer subsistema que observe um comportamento
 * potencialmente malicioso chama isto — nunca decide sozinho parar o bot ou
 * apagar algo.
 *
 * @param {object} signal
 * @param {string} signal.botId
 * @param {string} signal.source - de onde veio (ex.: 'security_wrapper', 'fileManager', 'cgroup')
 * @param {string} signal.code - código enumerado (ver SIGNAL_CATEGORY)
 * @param {object} [signal.details] - contexto adicional (NUNCA deve incluir segredos/tokens — só metadados)
 * @returns {{ severity: string, triggered: boolean }}
 */
function reportSignal({ botId, source, code, details = {} }) {
    if (!botId || !code) {
        throw new Error('SecurityEngine.reportSignal requer botId e code');
    }

    const kamikazeEnabled = config.security.kamikaze.enabled;

    if (!kamikazeEnabled) {
        // Kamikaze desligado no config: ainda registramos o sinal (a
        // visibilidade de segurança não deveria depender do interruptor de
        // resposta automática), mas nunca aciona o IncidentResponseManager.
        recordAuditEvent({
            userId: null,
            event: `security_signal:${code}`,
            details: JSON.stringify({ botId, source, details, note: 'kamikaze desabilitado — apenas registrado' }),
            severity: 'info',
        });
        return { severity: SEVERITY.SUSPICIOUS, triggered: false };
    }

    const result = classify(botId, code);

    recordAuditEvent({
        userId: null,
        event: `security_signal:${code}`,
        details: JSON.stringify({ botId, source, details, rule: result.rule, severity: result.severity }),
        severity: result.severity.toLowerCase(),
    });

    if (result.severity === SEVERITY.HIGH) {
        const title = `🟠 Comportamento suspeito monitorado: bot ${botId}`;
        const msg = `Padrão repetido de comportamento potencialmente malicioso detectado (código: \`${code}\`). ` +
            `O bot permanece online, mas o monitoramento foi aumentado. Nenhuma ação destrutiva foi tomada.`;
        sendAlert(title, msg, 'warning');
        notifyBotOwner(botId,
            '🟡 Comportamento suspeito detectado no seu bot',
            'Identificamos um padrão de comportamento potencialmente malicioso no seu bot e aumentamos o monitoramento dele. ' +
            'Nenhuma ação foi tomada por enquanto — se o padrão persistir ou se agravar, medidas automáticas de proteção podem ser aplicadas.'
        );
    }

    if (result.severity === SEVERITY.CRITICAL) {
        // Lazy require: quebra o ciclo SecurityEngine -> IncidentResponseManager
        // -> processManager -> SecurityEngine (todos top-level requires,
        // exceto este, que só resolve em tempo de execução, depois que todo
        // mundo já terminou de carregar).
        const { handleCriticalIncident } = require('./IncidentResponseManager');
        handleCriticalIncident(botId, {
            source,
            code,
            details,
            rule: result.rule,
            evidence: result.evidence,
        }).catch((err) => {
            console.error(`[SecurityEngine] Falha ao acionar IncidentResponseManager pro bot ${botId}:`, err.message);
        });
        return { severity: SEVERITY.CRITICAL, triggered: true };
    }

    return { severity: result.severity, triggered: false };
}

module.exports = {
    SEVERITY,
    SIGNAL_CATEGORY,
    HARD_EVIDENCE_CODES,
    reportSignal,
};
