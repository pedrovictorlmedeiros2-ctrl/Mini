/**
 * GERENCIADOR DE USUÁRIOS
 * Cria e gerencia usuários no banco de dados
 *
 * Melhorias:
 * - Hierarquia de roles via tabela de níveis (elimina ifs encadeados)
 * - Validação de role válida em setUserRole
 */
const { run, get } = require('../database/database');
const config = require('../../config');

// Hierarquia de roles: quanto maior o número, mais permissões
const ROLE_HIERARCHY = { viewer: 1, client: 2, moderator: 3, admin: 4 };
const VALID_ROLES = Object.keys(ROLE_HIERARCHY);

/**
 * Registra ou atualiza um usuario
 *
 * CORREÇÃO CRÍTICA (bootstrap de admin): antes, TODO usuário novo era sempre
 * criado com role 'client' — inclusive o dono do bot (OWNER_ID no .env).
 * `setUserRole('admin')` existe no sistema mas nunca era chamado em lugar
 * NENHUM do código (nem automaticamente, nem por nenhum botão/comando) — ou
 * seja, não existia NENHUM caminho, através do uso normal do bot, para
 * qualquer pessoa (incluindo o próprio dono) virar admin de verdade dentro do
 * sistema interno de permissões (hasPermission). Resultado: o painel
 * /admin-vendas abria normalmente (esse acesso é controlado pelo Discord via
 * PermissionFlagsBits.Administrator, um sistema totalmente separado), mas
 * TODO botão dentro dele batia em hasPermission(id, 'admin') e retornava
 * "Acesso negado" pra qualquer um — o painel inteiro de administração era
 * inutilizável, permanentemente, pra todo mundo, sem exceção.
 * Agora, sempre que o dono (comparado ao OWNER_ID do .env) interage com o
 * bot, ele é automaticamente promovido a admin — tanto na criação do
 * registro quanto (self-healing) em quem já existia sem a promoção.
 */
function registerUser(user) {
    const isOwner = config.bot.ownerId && user.id === config.bot.ownerId;
    const exists = get('SELECT id, role FROM users WHERE id = ?', [user.id]);
    if (exists) {
        run(
            "UPDATE users SET username = ?, discriminator = ?, avatar = ?, updated_at = datetime('now') WHERE id = ?",
            [user.username, user.discriminator, user.avatar, user.id]
        );
        if (isOwner && exists.role !== 'admin') {
            run("UPDATE users SET role = 'admin' WHERE id = ?", [user.id]);
        }
    } else {
        run(
            'INSERT INTO users (id, username, discriminator, avatar, role) VALUES (?, ?, ?, ?, ?)',
            [user.id, user.username, user.discriminator, user.avatar, isOwner ? 'admin' : 'client']
        );
    }
    return get('SELECT * FROM users WHERE id = ?', [user.id]);
}

/**
 * Obtem usuario
 */
function getUser(userId) {
    return get('SELECT * FROM users WHERE id = ?', [userId]);
}

/**
 * Verifica se um usuário tem pelo menos o nível de permissão requerido
 */
function hasPermission(userId, requiredRole) {
    const user = getUser(userId);
    if (!user) return false;
    const userLevel = ROLE_HIERARCHY[user.role] || 0;
    const requiredLevel = ROLE_HIERARCHY[requiredRole] || 0;
    return userLevel >= requiredLevel;
}

/**
 * Atualiza role do usuário (valida se a role é válida)
 */
function setUserRole(userId, role) {
    if (!VALID_ROLES.includes(role)) {
        throw new Error(`Role inválida: ${role}. Roles válidas: ${VALID_ROLES.join(', ')}`);
    }
    run("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?", [role, userId]);
}

/**
 * Verifica se um usuario pode executar uma ação especifica em um bot:
 * precisa ser o dono, ter cargo de moderador/admin, ou ser colaborador
 * com a permissão específica exigida pela ação.
 *
 * CORREÇÃO CRÍTICA: antes esta função SEMPRE checava a permissão fixa 'view',
 * não importa a ação (start/stop/delete/backup/config...). Na prática isso
 * significava que qualquer colaborador com permissão mínima de 'view' conseguia
 * excluir o bot, trocar o token, etc. Agora cada chamador informa qual
 * permissão a ação realmente exige (ver chamadas em interactionHandler.js).
 * @param {string} userId
 * @param {object} bot
 * @param {string} requiredPermission - 'view' | 'start' | 'stop' | 'logs' | 'backup' | 'delete' | 'config'
 */
function canManageBot(userId, bot, requiredPermission = 'view') {
    if (!bot) return false;
    if (bot.creator_id === userId) return true;
    if (hasPermission(userId, 'moderator')) return true;

    const { hasBotPermission } = require('../managers/collaboratorManager');
    return hasBotPermission(userId, bot.id, requiredPermission);
}

module.exports = {
    registerUser,
    getUser,
    hasPermission,
    setUserRole,
    canManageBot,
    VALID_ROLES,
    ROLE_HIERARCHY,
};
