/**
 * CAPACITY MANAGER (Fase 3 — sistema comercial)
 *
 * ÚNICA função autorizada, em todo o sistema, a calcular e escrever
 * `users.max_bots/max_ram/max_cpu`. Resolve o problema explícito de
 * duas fontes de verdade disputando essas colunas:
 *
 *  - o sistema de vendas LEGADO (`planManager.activateUserPlan()`,
 *    ainda em produção, baseado em `users.plan_id` + tabela `plans`);
 *  - o sistema comercial NOVO (`commerce/EntitlementManager.js`,
 *    baseado em `commerce_entitlements`, fonte de verdade de
 *    capacidade do novo fluxo).
 *
 * DECISÃO (documentada aqui por ser a única definição normativa —
 * qualquer código que precise saber "de onde vem a capacidade de um
 * usuário" deve ler este comentário, não reimplementar a lógica):
 *
 *   1) Se o usuário tem um Entitlement ATIVO (`commerce_entitlements`,
 *      novo sistema) → a capacidade vem de lá. Entitlement é a fonte de
 *      verdade sempre que existir, ponto final.
 *   2) Senão, se o usuário tem `plan_id` setado (sistema legado ainda
 *      em uso) → a capacidade vem da tabela `plans`, exatamente como
 *      `activateUserPlan()` sempre calculou (preserva 100% o
 *      comportamento legado pra quem nunca passou pelo novo fluxo).
 *   3) Senão → capacidade default/free (`config.security.*`).
 *
 * As DUAS fontes nunca escrevem direto nas colunas — ambas (`planManager.
 * activateUserPlan()` e `EntitlementManager.recomputeUserCapacity()`)
 * delegam pra `recomputeUserCapacity()` aqui, que decide segundo a
 * precedência acima e faz a ÚNICA escrita. Isso elimina qualquer
 * corrida silenciosa entre os dois sistemas por construção — não é
 * convenção, é o único caminho de escrita que existe.
 *
 * O teto de segurança do host (HOST_MAX_*) é aplicado aqui, uma vez só
 * — antes vivia duplicado (quase idêntico) em `planManager.js` e em
 * `EntitlementManager.js`.
 */
const { get, run } = require('../database/database');
const config = require('../../config');

function applyHostCaps({ maxBots, maxRam, maxCpu }) {
    const hostRamCap = Number(process.env.HOST_MAX_RAM_PER_BOT) || 512;
    const hostCpuCap = Number(process.env.HOST_MAX_CPU_PER_BOT) || 50;
    const hostBotsCap = Number(process.env.HOST_MAX_BOTS_PER_USER) || 10;

    return {
        maxBots: Math.min(Number(maxBots) || 1, hostBotsCap),
        maxRam: Math.min(Number(maxRam) || 256, hostRamCap),
        maxCpu: Math.min(Number(maxCpu) || 30, hostCpuCap),
    };
}

function writeUserCapacity(userId, capacity) {
    const safe = applyHostCaps(capacity);
    run(
        "UPDATE users SET max_bots = ?, max_ram = ?, max_cpu = ?, updated_at = datetime('now') WHERE id = ?",
        [safe.maxBots, safe.maxRam, safe.maxCpu, userId]
    );
    return safe;
}

/**
 * Recalcula e escreve a capacidade efetiva de um usuário, seguindo a
 * precedência documentada no topo do arquivo. Chamada por
 * `planManager.activateUserPlan()` (legado) e por
 * `EntitlementManager.grant()`/`expireEntitlement()`/`revokeEntitlement()`
 * (novo) — nunca chamada diretamente pela camada de UI.
 *
 * Lazy require de EntitlementManager: evita um ciclo de carregamento
 * top-level (EntitlementManager também importa este módulo) — mesmo
 * padrão já usado no projeto pra quebrar ciclos (ex.:
 * SecurityEngine → IncidentResponseManager).
 */
function recomputeUserCapacity(userId) {
    const { getActiveEntitlement } = require('./commerce/EntitlementManager');
    const activeEntitlement = getActiveEntitlement(userId);

    if (activeEntitlement) {
        const order = get('SELECT product_snapshot FROM commerce_orders WHERE id = ?', [activeEntitlement.order_id]);
        const snapshot = JSON.parse(order.product_snapshot);
        return writeUserCapacity(userId, { maxBots: snapshot.maxBots, maxRam: snapshot.maxRam, maxCpu: snapshot.maxCpu });
    }

    const user = get('SELECT plan_id FROM users WHERE id = ?', [userId]);
    if (user && user.plan_id) {
        const plan = get('SELECT * FROM plans WHERE id = ?', [user.plan_id]);
        if (plan) {
            return writeUserCapacity(userId, { maxBots: plan.max_bots, maxRam: plan.max_ram, maxCpu: plan.max_cpu });
        }
    }

    return writeUserCapacity(userId, {
        maxBots: config.security.maxBotsPerUser,
        maxRam: config.security.maxRamPerBot,
        maxCpu: config.security.maxCpuPerBot,
    });
}

module.exports = {
    recomputeUserCapacity,
    applyHostCaps,
    writeUserCapacity,
};
