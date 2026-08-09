/**
 * GERENCIADOR DE COLABORADORES
 * Gerencia permissões compartilhadas para bots.
 */
const { get, run, query } = require('../database/database');

/**
 * Adiciona um colaborador a um bot
 */
function addCollaborator(botId, userId, permissions = 'view,start,stop,logs') {
    run(`
        INSERT INTO bot_collaborators (bot_id, user_id, permissions)
        VALUES (?, ?, ?)
        ON CONFLICT(bot_id, user_id) DO UPDATE SET permissions = excluded.permissions
    `, [botId, userId, permissions]);
}

/**
 * Remove um colaborador de um bot
 */
function removeCollaborator(botId, userId) {
    run("DELETE FROM bot_collaborators WHERE bot_id = ? AND user_id = ?", [botId, userId]);
}

/**
 * Lista todos os colaboradores de um bot
 */
function getCollaborators(botId) {
    return query(`
        SELECT c.*, u.username 
        FROM bot_collaborators c 
        JOIN users u ON c.user_id = u.id 
        WHERE c.bot_id = ?
    `, [botId]);
}

/**
 * Verifica se um usuário tem permissão específica em um bot
 */
function hasBotPermission(userId, botId, permission) {
    const bot = get("SELECT creator_id FROM bots WHERE id = ?", [botId]);
    if (bot && bot.creator_id === userId) return true;

    const collab = get("SELECT permissions FROM bot_collaborators WHERE bot_id = ? AND user_id = ?", [botId, userId]);
    if (!collab) return false;

    const perms = collab.permissions.split(',');
    return perms.includes(permission);
}

module.exports = {
    addCollaborator,
    removeCollaborator,
    getCollaborators,
    hasBotPermission
};
