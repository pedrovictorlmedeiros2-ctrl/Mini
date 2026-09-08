/**
 * SIGNAL COLLECTOR (SecurityMonitor — Fase 2)
 *
 * Lê o audit_log (append-only, já escrito por SecurityEngine.reportSignal()
 * pra TODO sinal, sem exceção) de forma incremental e totalmente
 * desacoplada — nenhum hook novo dentro do SecurityEngine, nenhuma
 * mudança lá. O cursor avança por id, nunca reprocessa a mesma linha.
 *
 * Nunca faz varredura de disco nem lê arquivo nenhum — só a tabela
 * audit_log, que já é só metadados (nunca conteúdo de arquivo/backup).
 *
 * Isolamento de tenant: cada linha do audit_log já carrega o botId de
 * origem dentro do seu próprio JSON — o agrupamento por bot aqui só
 * preserva essa separação, nunca combina dados de bots diferentes numa
 * mesma entrada.
 */
const { query } = require('../../../database/database');
const { SIGNAL_CATEGORY } = require('../SecurityEngine');
const { ensureAuditTable } = require('../../auditManager');

const SECURITY_SIGNAL_PREFIX = 'security_signal:';
const SEVERITY_RANK = { SUSPICIOUS: 1, HIGH: 2, CRITICAL: 3 };
const MAX_ROWS_PER_POLL = 500;

let cursor = 0;

function parseSecuritySignalRow(row) {
    if (!row.action || !row.action.startsWith(SECURITY_SIGNAL_PREFIX)) return null;
    const code = row.action.slice(SECURITY_SIGNAL_PREFIX.length);

    let parsed;
    try {
        parsed = JSON.parse(row.details);
    } catch {
        return null; // linha corrompida/malformada — nunca quebra o coletor, só ignora
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.botId) return null;

    return {
        auditId: row.id,
        botId: parsed.botId,
        source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
        code,
        severity: typeof parsed.severity === 'string' ? parsed.severity : 'SUSPICIOUS',
        // `details` aqui ainda NÃO está redigido — é responsabilidade de
        // quem consome isto (redactPayload.js) antes de qualquer coisa
        // sair do processo.
        rawDetails: parsed.details || {},
        timestamp: row.created_at,
    };
}

/**
 * Agrupa uma lista de eventos (já do MESMO bot) por código, somando
 * ocorrências e guardando a severidade mais alta observada — é esse
 * resumo, um por código, que vira um "evento" no payload pro Groq (ver
 * redactPayload.buildGroqEventPayload).
 */
function summarizeEventsByCode(events) {
    const byCode = new Map();
    for (const evt of events) {
        if (!byCode.has(evt.code)) {
            byCode.set(evt.code, {
                code: evt.code,
                source: evt.source,
                category: SIGNAL_CATEGORY[evt.code] || 'unknown',
                severity: evt.severity,
                occurrences: 0,
                firstSeenAt: evt.timestamp,
                lastSeenAt: evt.timestamp,
                matchedPath: typeof evt.rawDetails?.matchedPath === 'string' ? evt.rawDetails.matchedPath : null,
            });
        }
        const agg = byCode.get(evt.code);
        agg.occurrences += 1;
        agg.lastSeenAt = evt.timestamp;
        if ((SEVERITY_RANK[evt.severity] || 0) > (SEVERITY_RANK[agg.severity] || 0)) {
            agg.severity = evt.severity;
        }
    }
    return Array.from(byCode.values());
}

/**
 * Lê as linhas novas do audit_log desde o último poll, agrupadas por bot.
 * NUNCA lê o mesmo id duas vezes (cursor monotônico). Retorna um Map
 * botId -> eventos resumidos (já agregados por código) — pronto pra virar
 * um payload allowlisted (ver redactPayload.js).
 *
 * @returns {Map<string, Array<object>>}
 */
function pollNewSecurityEvents() {
    // audit_log é criada sob demanda (auditManager.ensureAuditTable, chamada
    // de dentro de recordAuditEvent) — numa instalação nova, antes do
    // PRIMEIRO sinal de segurança de qualquer bot, a tabela pode ainda não
    // existir. Garantir aqui evita que o monitor quebre num boot limpo.
    ensureAuditTable();
    const rows = query(
        `SELECT * FROM audit_log WHERE id > ? AND action LIKE ? ORDER BY id ASC LIMIT ?`,
        [cursor, `${SECURITY_SIGNAL_PREFIX}%`, MAX_ROWS_PER_POLL]
    );
    if (!rows.length) return new Map();

    cursor = rows[rows.length - 1].id;

    const byBot = new Map();
    for (const row of rows) {
        const evt = parseSecuritySignalRow(row);
        if (!evt) continue;
        if (!byBot.has(evt.botId)) byBot.set(evt.botId, []);
        byBot.get(evt.botId).push(evt);
    }

    const summarized = new Map();
    for (const [botId, events] of byBot.entries()) {
        summarized.set(botId, summarizeEventsByCode(events));
    }
    return summarized;
}

function getCursor() {
    return cursor;
}

// Hook de teste — nunca usado por código de produção. O cursor é estado de
// módulo compartilhado (avança sobre a mesma tabela pra qualquer chamador),
// então testes que rodam em sequência no mesmo processo precisam de uma
// forma de resetar entre casos isolados. Sem argumento, reseta pro fim
// ATUAL da tabela (não pro id 0) — do contrário, num arquivo de teste que
// compartilha um único banco entre casos, resetar pra 0 faria o poll
// seguinte reprocessar sinais de bots criados por casos de teste
// anteriores, quebrando qualquer asserção de isolamento/contagem exata.
function _resetCursorForTests(value) {
    if (typeof value === 'number') {
        cursor = value;
        return;
    }
    ensureAuditTable();
    const last = query('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1');
    cursor = last.length ? last[0].id : 0;
}

module.exports = {
    pollNewSecurityEvents,
    summarizeEventsByCode,
    getCursor,
    _resetCursorForTests,
};
