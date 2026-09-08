/**
 * SECURITY MONITOR (Fase 2) — orquestrador
 *
 * Liga as peças já construídas nesta fase, cada uma com sua própria
 * responsabilidade única:
 *
 *   SignalCollector      → lê o audit_log incrementalmente, agrupado por bot
 *   redactPayload         → allowlist estrita, nunca texto livre arbitrário
 *   GroqThreatAnalyzer     → chamada de rede com timeout/retry/backoff/circuito
 *   ThreatDecisionPolicy   → único ponto que pode alimentar SecurityEngine de volta
 *
 * Este arquivo NUNCA importa Groq diretamente (só através de
 * GroqThreatAnalyzer.js) e NUNCA importa IncidentResponseManager — nenhuma
 * ação crítica é tomada aqui, só orquestração de leitura/observação.
 *
 * "Processo principal nunca bloqueia esperando o Groq": o timer de poll
 * (setInterval, unref'd — mesmo padrão de serviceReadiness.js) só ENFILEIRA
 * uma tarefa de baixa prioridade por bot em queueManager.js (fila já
 * existente, com concorrência limitada e timeout por tarefa) e retorna na
 * hora — nunca faz `await` na chamada ao Groq dentro do próprio timer. Cada
 * tarefa segue seu caminho assíncrono independente; um Groq lento atrasa no
 * máximo a PRÓPRIA fila de baixa prioridade, nunca o event loop principal
 * nem qualquer outra operação da plataforma.
 */
const { pollNewSecurityEvents } = require('./SignalCollector');
const { buildGroqEventPayload } = require('./redactPayload');
const { analyzeThreat: defaultAnalyzeThreat, maxPossibleDurationMs } = require('./GroqThreatAnalyzer');
const { applyThreatDecision } = require('./ThreatDecisionPolicy');
const { addToQueue } = require('../../queueManager');
const { recordAuditEvent } = require('../../auditManager');
const config = require('../../../../config');

let pollTimer = null;
let pollInFlight = false;

// Indireção só pra permitir injeção em teste (mesmo espírito do
// `options.httpPost` do GroqThreatAnalyzer) sem acoplar SecurityMonitor a
// nenhum detalhe de rede — em produção é sempre a implementação real.
let analyzeThreatImpl = defaultAnalyzeThreat;

// ── SAÚDE OPERACIONAL DO GROQ (pra serviceReadiness.js) ──────────────────
// Só conta como "falha operacional" uma chamada feita com o monitor
// HABILITADO e GROQ_API_KEY configurada — "desabilitado" ou "sem chave" são
// escolhas do operador, nunca uma indisponibilidade real, e nunca deveriam
// aparecer como DEGRADED.
const health = {
    totalOperationalAttempts: 0,
    consecutiveUnavailable: 0,
    lastAttemptAt: null,
    lastAvailableAt: null,
};

function isOperationalAttempt() {
    const cfg = config.security.groqMonitor;
    return !!(cfg.enabled && process.env.GROQ_API_KEY);
}

function recordHealthResult(wasOperationalAttempt, available) {
    if (!wasOperationalAttempt) return; // desabilitado/sem chave — não conta pra saúde
    health.totalOperationalAttempts += 1;
    health.lastAttemptAt = new Date().toISOString();
    if (available) {
        health.consecutiveUnavailable = 0;
        health.lastAvailableAt = health.lastAttemptAt;
    } else {
        health.consecutiveUnavailable += 1;
    }
}

/**
 * Uma tarefa completa: bot -> payload allowlisted -> Groq -> decisão. Cada
 * chamada é isolada a UM bot só (nunca mistura eventos de bots diferentes
 * no mesmo payload/request) — ver SignalCollector.js e buildGroqEventPayload.
 */
async function analyzeBotEvents(botId, events) {
    const wasOperationalAttempt = isOperationalAttempt();
    const payload = buildGroqEventPayload(botId, events);
    const result = await analyzeThreatImpl(payload);
    recordHealthResult(wasOperationalAttempt, result.available);
    applyThreatDecision(botId, result);
    return result;
}

/**
 * Lê os sinais novos desde o último poll e ENFILEIRA (nunca espera) uma
 * análise por bot. Retorna assim que o enfileiramento termina — não espera
 * nenhuma tarefa da fila concluir.
 */
async function pollAndEnqueue() {
    if (pollInFlight) return; // evita sobrepor leituras do cursor se um poll anterior ainda está enfileirando
    pollInFlight = true;
    try {
        const byBot = pollNewSecurityEvents();
        // ACHADO DE REVISÃO DE SEGURANÇA: a margem antiga (requestTimeoutMs +
        // 5000, fixa) ficava ABAIXO do pior caso real de analyzeThreat() sob
        // a config default (maxRetries=1 já soma até 10500ms de tentativas
        // legítimas contra uma margem de só 10000ms) — o timeout da FILA
        // podia matar uma tentativa que ainda estava dentro do próprio
        // orçamento de retry/backoff do GroqThreatAnalyzer, sem cancelar a
        // chamada de rede de verdade (só solta o slot da fila mais cedo).
        // maxPossibleDurationMs() calcula o pior caso real pra config atual,
        // com uma margem extra por cima.
        const taskTimeoutMs = maxPossibleDurationMs(config.security.groqMonitor) + 2000;
        for (const [botId, events] of byBot.entries()) {
            addToQueue(
                () => analyzeBotEvents(botId, events),
                `groq-monitor:${botId}`,
                { priority: 'low', timeoutMs: taskTimeoutMs }
            ).catch((err) => {
                // addToQueue só rejeita por timeout da fila ou erro não tratado
                // dentro de analyzeBotEvents — nunca deveria acontecer com
                // analyzeThreat (que já nunca lança), mas se acontecer, fica
                // auditável e nunca derruba o timer do monitor.
                recordAuditEvent({
                    userId: null,
                    event: 'groq_monitor:task_failed',
                    details: JSON.stringify({ botId, error: err.message }),
                    severity: 'warning',
                });
            });
        }
    } catch (err) {
        console.error('[SecurityMonitor] Falha ao coletar sinais do audit_log:', err.message);
    } finally {
        pollInFlight = false;
    }
}

function startSecurityMonitor() {
    if (pollTimer) return;
    const intervalMs = config.security.groqMonitor.pollIntervalMs;
    pollTimer = setInterval(() => {
        pollAndEnqueue();
    }, intervalMs);
    if (pollTimer.unref) pollTimer.unref();
}

function stopSecurityMonitor() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

/** Leitura barata pro serviceReadiness.js — nunca recalcula nada, só expõe o estado já observado. */
function getGroqMonitorHealth() {
    return { ...health };
}

// ── Hooks de teste — nunca usados por código de produção. ────────────────
function _setAnalyzeThreatForTests(fn) {
    analyzeThreatImpl = fn;
}
function _resetForTests() {
    analyzeThreatImpl = defaultAnalyzeThreat;
    health.totalOperationalAttempts = 0;
    health.consecutiveUnavailable = 0;
    health.lastAttemptAt = null;
    health.lastAvailableAt = null;
    pollInFlight = false;
}

module.exports = {
    pollAndEnqueue,
    analyzeBotEvents,
    startSecurityMonitor,
    stopSecurityMonitor,
    getGroqMonitorHealth,
    _setAnalyzeThreatForTests,
    _resetForTests,
};
