/**
 * GERENCIADOR DE NODES (MULTI-NODE) — v2
 * Balanceamento, heartbeat e failover básico.
 *
 * Melhorias:
 * - Marca nodes sem heartbeat recente como offline
 * - Score de capacidade (RAM livre + CPU livre)
 * - Evita colocar bots em node saturado
 * - Contagem de bots por node no score
 */
const { get, run, query } = require('../database/database');
const axios = require('axios');

const HEARTBEAT_STALE_SEC = 90;

/**
 * Registra ou atualiza um Node escravo
 */
function registerNode(nodeData) {
    const { id, name, ip, port, secret_key, total_ram, total_cpu } = nodeData;
    run(`
        INSERT INTO nodes (id, name, ip, port, secret_key, status, total_ram, total_cpu)
        VALUES (?, ?, ?, ?, ?, 'offline', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            ip=excluded.ip,
            port=excluded.port,
            secret_key=excluded.secret_key,
            total_ram=COALESCE(excluded.total_ram, nodes.total_ram),
            total_cpu=COALESCE(excluded.total_cpu, nodes.total_cpu)
    `, [id, name, ip, port, secret_key, total_ram || null, total_cpu || 100]);
}

/**
 * Nodes que não enviam heartbeat há > HEARTBEAT_STALE_SEC são marcados offline.
 */
function markStaleNodesOffline() {
    try {
        run(`
            UPDATE nodes SET status = 'offline'
            WHERE id != 'master'
              AND status = 'online'
              AND (last_heartbeat IS NULL OR last_heartbeat < datetime('now', ?))
        `, [`-${HEARTBEAT_STALE_SEC} seconds`]);
    } catch { /* ignore */ }
}

/**
 * Envia um comando para um Node específico
 */
async function sendNodeCommand(nodeId, action, data = {}) {
    if (nodeId === 'master') {
        return { success: true, message: 'Comando processado localmente no Master.' };
    }

    const node = get('SELECT * FROM nodes WHERE id = ?', [nodeId]);
    if (!node) throw new Error('Node não encontrado.');

    try {
        const response = await axios.post(
            `http://${node.ip}:${node.port}/execute`,
            { action, data, secret: node.secret_key },
            { timeout: 8000 }
        );
        return response.data;
    } catch (err) {
        run("UPDATE nodes SET status = 'offline' WHERE id = ?", [nodeId]);
        throw new Error(`Falha na comunicação com o Node ${node.name}: ${err.message}`);
    }
}

/**
 * Seleciona o melhor Node para hospedar um novo bot (balanceamento).
 * Score = RAM livre normalizada + CPU livre + bônus por poucos bots.
 */
function getBestNode() {
    markStaleNodesOffline();

    const nodes = query(`
        SELECT n.*,
            (SELECT COUNT(*) FROM bots b WHERE b.node_id = n.id AND b.status = 'online') AS online_bots
        FROM nodes n
        WHERE n.status = 'online'
    `);

    if (!nodes || nodes.length === 0) return 'master';

    let best = null;
    let bestScore = -Infinity;

    for (const n of nodes) {
        const totalRam = Number(n.total_ram) || 8192;
        const usedRam = Number(n.used_ram) || 0;
        const totalCpu = Number(n.total_cpu) || 100;
        const usedCpu = Number(n.used_cpu) || 0;
        const onlineBots = Number(n.online_bots) || 0;

        const ramFreeRatio = Math.max(0, (totalRam - usedRam) / totalRam);
        const cpuFreeRatio = Math.max(0, (totalCpu - usedCpu) / totalCpu);

        // Rejeita nodes claramente saturados
        if (ramFreeRatio < 0.08 || cpuFreeRatio < 0.05) continue;

        const score = (ramFreeRatio * 0.5) + (cpuFreeRatio * 0.35) + (1 / (1 + onlineBots)) * 0.15;
        if (score > bestScore) {
            bestScore = score;
            best = n;
        }
    }

    return best ? best.id : 'master';
}

/**
 * Atualiza o status/saúde de um Node (Heartbeat)
 */
function updateNodeHeartbeat(nodeId, stats = {}) {
    run(`
        UPDATE nodes SET
            status = 'online',
            used_ram = COALESCE(?, used_ram),
            used_cpu = COALESCE(?, used_cpu),
            total_ram = COALESCE(?, total_ram),
            total_cpu = COALESCE(?, total_cpu),
            last_heartbeat = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [
        stats.used_ram ?? null,
        stats.used_cpu ?? null,
        stats.total_ram ?? null,
        stats.total_cpu ?? null,
        nodeId,
    ]);
}

/**
 * Lista nodes com saúde resumida (para painel admin / diagnóstico)
 */
function listNodesHealth() {
    markStaleNodesOffline();
    return query(`
        SELECT n.*,
            (SELECT COUNT(*) FROM bots b WHERE b.node_id = n.id) AS total_bots,
            (SELECT COUNT(*) FROM bots b WHERE b.node_id = n.id AND b.status = 'online') AS online_bots
        FROM nodes n
        ORDER BY n.status DESC, n.name ASC
    `);
}

module.exports = {
    registerNode,
    sendNodeCommand,
    getBestNode,
    updateNodeHeartbeat,
    markStaleNodesOffline,
    listNodesHealth,
};
