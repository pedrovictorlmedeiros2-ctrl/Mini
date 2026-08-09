/**
 * GERENCIADOR DE LOGS DO SISTEMA
 * Registra todas as acoes em banco de dados
 */
const { run, query } = require('../database/database');
const config = require('../../config');

/**
 * Registra uma acao no log
 */
function logAction(botId, userId, action, details = '', type = 'info') {
    run(
        'INSERT INTO logs (bot_id, user_id, action, details, type) VALUES (?, ?, ?, ?, ?)',
        [botId || null, userId || null, action, details, type]
    );
}

/**
 * NOVA FEATURE (logs categorizados): a coluna 'type' na tabela logs já
 * existia, mas todo mundo chamava logAction() sem informar o tipo, então
 * tudo caía em 'info' — não dava pra separar "log de auditoria comum" de
 * "tentativa de acesso negada" (evento de segurança). Estes helpers deixam
 * isso explícito nos pontos que realmente importam (ex: IDOR bloqueado).
 */
function logSecurityEvent(userId, event, details = '') {
    run(
        'INSERT INTO logs (bot_id, user_id, action, details, type) VALUES (?, ?, ?, ?, ?)',
        [null, userId || null, event, details, 'security']
    );
}

function logError(botId, event, details = '') {
    run(
        'INSERT INTO logs (bot_id, user_id, action, details, type) VALUES (?, ?, ?, ?, ?)',
        [botId || null, null, event, details, 'error']
    );
}

/**
 * Registra acao do usuario
 */
function logUserAction(userId, botId, action, details = '') {
    run(
        'INSERT INTO action_history (user_id, bot_id, action, details) VALUES (?, ?, ?, ?)',
        [userId, botId || null, action, details]
    );
}

/**
 * Obtem logs de um bot
 */
function getBotLogs(botId, limit = 50) {
    return query(
        'SELECT * FROM logs WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?',
        [botId, limit]
    );
}

/**
 * Obtem historico de acoes de um usuario
 */
function getUserHistory(userId, limit = 50) {
    return query(
        'SELECT * FROM action_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
        [userId, limit]
    );
}

/**
 * Obtem todos os logs do sistema
 */
function getAllLogs(limit = 100) {
    return query(
        'SELECT l.*, b.name as bot_name, u.username FROM logs l ' +
        'LEFT JOIN bots b ON l.bot_id = b.id ' +
        'LEFT JOIN users u ON l.user_id = u.id ' +
        'ORDER BY l.created_at DESC LIMIT ?',
        [limit]
    );
}

/**
 * Obtem logs filtrados por categoria (security, error, info...) — permite
 * ao staff ver só os eventos de segurança, ou só os erros, sem precisar
 * garimpar no meio de todos os logs de auditoria comuns.
 */
function getLogsByType(type, limit = 50) {
    return query(
        'SELECT l.*, b.name as bot_name, u.username FROM logs l ' +
        'LEFT JOIN bots b ON l.bot_id = b.id ' +
        'LEFT JOIN users u ON l.user_id = u.id ' +
        'WHERE l.type = ? ORDER BY l.created_at DESC LIMIT ?',
        [type, limit]
    );
}

module.exports = {
    logAction,
    logSecurityEvent,
    logError,
    logUserAction,
    getBotLogs,
    getUserHistory,
    getAllLogs,
    getLogsByType,
};
