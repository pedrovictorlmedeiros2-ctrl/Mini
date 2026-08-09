/**
 * FAILOVER MANAGER — Multi-node recovery
 *
 * Periodicamente:
 *  1. Detecta nodes offline (heartbeat stale)
 *  2. Lista bots que estavam nesse node e marcados online
 *  3. Reatribui para o melhor node disponível (getBestNode)
 *  4. Tenta reiniciar localmente se o novo node for master
 *  5. Ou envia comando remoto se for worker
 *
 * Ative com FAILOVER_ENABLED=true
 */
const { query, run, get } = require('../database/database');
const {
    markStaleNodesOffline,
    getBestNode,
    sendNodeCommand,
    listNodesHealth,
} = require('./nodeManager');
const { logAction } = require('./logManager');

const INTERVAL_MS = Number(process.env.FAILOVER_INTERVAL_MS) || 45 * 1000;
let timer = null;
let running = false;

function failoverEnabled() {
    const v = String(process.env.FAILOVER_ENABLED || '').toLowerCase();
    return v === 'true' || v === '1';
}

/**
 * Bots que estavam em nodes agora offline.
 */
function findOrphanedBots() {
    markStaleNodesOffline();
    return query(`
        SELECT b.*
        FROM bots b
        JOIN nodes n ON n.id = b.node_id
        WHERE n.status = 'offline'
          AND n.id != 'master'
          AND b.status = 'online'
    `);
}

/**
 * Reagenda um bot órfão para o melhor node online.
 */
async function rescheduleBot(bot) {
    const targetNode = getBestNode();
    if (!targetNode) {
        console.warn(`[FAILOVER] Sem node disponível para bot ${bot.id}`);
        return false;
    }

    const previous = bot.node_id;
    run('UPDATE bots SET node_id = ?, status = ? WHERE id = ?', [targetNode, 'offline', bot.id]);
    logAction(
        bot.id,
        null,
        'FAILOVER',
        `Bot reagendado de node ${previous} → ${targetNode} (node anterior offline)`
    );

    try {
        if (targetNode === 'master') {
            const { startBot } = require('./processManager');
            await startBot(bot.id);
        } else {
            await sendNodeCommand(targetNode, 'start', { botId: bot.id });
            run("UPDATE bots SET status = 'online' WHERE id = ?", [bot.id]);
        }
        console.log(`[FAILOVER] Bot ${bot.code || bot.id} movido ${previous} → ${targetNode}`);
        return true;
    } catch (err) {
        console.error(`[FAILOVER] Falha ao reiniciar bot ${bot.id} em ${targetNode}:`, err.message);
        run("UPDATE bots SET status = 'offline' WHERE id = ?", [bot.id]);
        return false;
    }
}

async function runFailoverCycle() {
    if (running || !failoverEnabled()) return;
    running = true;
    try {
        const orphans = findOrphanedBots();
        if (orphans.length === 0) return;

        console.warn(`[FAILOVER] ${orphans.length} bot(s) órfão(s) detectado(s). Reagendando...`);
        let ok = 0;
        for (const bot of orphans) {
            if (await rescheduleBot(bot)) ok += 1;
        }
        console.log(`[FAILOVER] Ciclo concluído: ${ok}/${orphans.length} recuperados.`);
    } catch (err) {
        console.error('[FAILOVER] Erro no ciclo:', err.message);
    } finally {
        running = false;
    }
}

function startFailoverScheduler() {
    if (!failoverEnabled()) {
        console.log('[FAILOVER] Desabilitado (FAILOVER_ENABLED!=true).');
        return;
    }
    if (timer) clearInterval(timer);
    // Primeira checagem após 20s do boot
    setTimeout(() => runFailoverCycle().catch(() => {}), 20000).unref?.();
    timer = setInterval(() => runFailoverCycle().catch(() => {}), INTERVAL_MS);
    timer.unref?.();
    console.log(`[FAILOVER] Scheduler ativo (intervalo ${INTERVAL_MS / 1000}s).`);
}

function stopFailoverScheduler() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

module.exports = {
    startFailoverScheduler,
    stopFailoverScheduler,
    runFailoverCycle,
    findOrphanedBots,
    rescheduleBot,
    failoverEnabled,
};
