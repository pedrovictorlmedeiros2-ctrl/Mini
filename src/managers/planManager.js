/**
 * GERENCIADOR DE PLANOS v2
 * Gerencia planos dinâmicos salvos no banco de dados.
 */
const { get, run, query } = require('../database/database');

/**
 * Cria ou atualiza um plano
 */
function savePlan(planData) {
    // CORREÇÃO CRÍTICA (bug real reportado: "Provided value cannot be bound to
    // SQLite parameter 3"): o modal de criar plano só envia id/name/price/
    // max_bots/max_ram/status — nunca description, storage, color,
    // role_to_add, role_to_remove nem icon. Como esses campos ficavam
    // `undefined` no objeto planData, o destructuring abaixo também resultava
    // em `undefined`, e o driver nativo do SQLite (node:sqlite) rejeita
    // `undefined` como parâmetro vinculado (só aceita null, não undefined) —
    // por isso o erro sempre no parâmetro 3 (description, a primeira coluna
    // opcional da lista). Agora preenchemos cada campo ausente com um valor
    // padrão sensato (o mesmo que a coluna já usaria via DEFAULT, quando
    // existe) em vez de propagar `undefined` pro SQLite.
    const {
        id, name, price, max_bots, max_ram,
        description = null,
        max_cpu = 100,
        storage = 1024,
        color = '#00FF00',
        role_to_add = null,
        role_to_remove = null,
        icon = null,
        status = 'active',
    } = planData;

    run(`
        INSERT INTO plans (id, name, description, price, max_bots, max_ram, max_cpu, storage, color, role_to_add, role_to_remove, icon, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name, description=excluded.description, price=excluded.price,
            max_bots=excluded.max_bots, max_ram=excluded.max_ram, max_cpu=excluded.max_cpu,
            storage=excluded.storage, color=excluded.color, role_to_add=excluded.role_to_add,
            role_to_remove=excluded.role_to_remove, icon=excluded.icon, status=excluded.status
    `, [id, name, description, price, max_bots, max_ram, max_cpu, storage, color, role_to_add, role_to_remove, icon, status]);
}

/**
 * Obtém todos os planos ativos
 */
function getAllPlans(onlyActive = true) {
    if (onlyActive) {
        return query("SELECT * FROM plans WHERE status = 'active' ORDER BY price ASC");
    }
    return query("SELECT * FROM plans ORDER BY price ASC");
}

/**
 * Obtém um plano por ID
 */
function getPlan(planId) {
    return get("SELECT * FROM plans WHERE id = ?", [planId]);
}

/**
 * Ativa um plano para um usuário (Aprovação de Compra)
 * @param {string} userId
 * @param {string} planId
 * @param {import('discord.js').Client} client
 * @param {import('discord.js').Guild} [guild] - Servidor onde gerenciar os cargos.
 *   CORREÇÃO: antes usava client.guilds.cache.first(), que pega um servidor
 *   arbitrário (o primeiro no cache, sem relação com onde a venda aconteceu).
 *   Se o bot estiver em mais de um servidor, isso podia tentar gerenciar
 *   cargos no servidor ERRADO e falhar silenciosamente (ou pior, afetar o
 *   cargo de um membro homônimo em outro servidor). Agora exige o guild
 *   correto; só cai para .first() como último recurso, com aviso no log.
 */
async function activateUserPlan(userId, planId, client, guild = null) {
    const plan = getPlan(planId);
    if (!plan) throw new Error('Plano não encontrado');

    // 1. Marca o plano do usuário e recalcula a capacidade efetiva.
    //
    // CORREÇÃO (Fase 3 — fonte única de capacidade): este UPDATE costumava
    // calcular e escrever max_bots/max_ram/max_cpu diretamente aqui, com
    // sua própria cópia da lógica de teto de host (HOST_MAX_*). O novo
    // sistema comercial (commerce/EntitlementManager.js) também escrevia
    // nas MESMAS colunas, de forma independente — duas fontes de verdade
    // podendo se sobrescrever silenciosamente. Agora as duas delegam pra
    // capacityManager.recomputeUserCapacity(), que decide com uma
    // precedência única e documentada (Entitlement ativo > plan_id
    // legado > default) e é o ÚNICO lugar que de fato escreve nessas
    // colunas — ver o comentário normativo em capacityManager.js.
    run("UPDATE users SET plan_id = ?, updated_at = datetime('now') WHERE id = ?", [planId, userId]);
    const capacityManager = require('./capacityManager');
    capacityManager.recomputeUserCapacity(userId);

    // 2. Gerencia cargos no Discord (se o client for fornecido)
    if (client) {
        try {
            let targetGuild = guild;
            if (!targetGuild) {
                console.warn(`⚠️ activateUserPlan chamado sem 'guild' explícito para o usuário ${userId} — usando o primeiro servidor do cache como fallback. Isso pode gerenciar cargos no servidor errado se o bot estiver em múltiplos servidores.`);
                targetGuild = client.guilds.cache.first();
            }
            if (!targetGuild) return;

            const member = await targetGuild.members.fetch(userId);

            if (plan.role_to_add) await member.roles.add(plan.role_to_add).catch(() => {});
            if (plan.role_to_remove) await member.roles.remove(plan.role_to_remove).catch(() => {});
        } catch (err) {
            console.error(`⚠️ Erro ao gerenciar cargos do usuário ${userId}:`, err.message);
        }
    }
}

/**
 * Verifica se o usuário pode adicionar mais um bot
 */
function canAddBot(userId) {
    const user = get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return false;
    
    const botCount = get('SELECT COUNT(*) as count FROM bots WHERE creator_id = ?', [userId]).count;
    return botCount < user.max_bots;
}

/**
 * Obtém informações do plano atual do usuário
 */
function getUserPlanInfo(userId) {
    const user = get(`
        SELECT u.*, p.name as plan_name, p.color as plan_color 
        FROM users u 
        LEFT JOIN plans p ON u.plan_id = p.id 
        WHERE u.id = ?
    `, [userId]);

    if (!user || !user.plan_id) {
        return {
            name: 'Nenhum / Free',
            maxBots: user?.max_bots || 1,
            maxRam: user?.max_ram || 256,
            maxCpu: user?.max_cpu || 30,
            currentBots: get('SELECT COUNT(*) as count FROM bots WHERE creator_id = ?', [userId]).count
        };
    }

    return {
        name: user.plan_name,
        color: user.plan_color,
        maxBots: user.max_bots,
        maxRam: user.max_ram,
        maxCpu: user.max_cpu,
        currentBots: get('SELECT COUNT(*) as count FROM bots WHERE creator_id = ?', [userId]).count
    };
}

module.exports = {
    savePlan,
    getAllPlans,
    getPlan,
    activateUserPlan,
    canAddBot,
    getUserPlanInfo
};
