/**
 * WORKER NODE AGENT — Multi-node real
 *
 * Roda em cada máquina escrava e:
 *  1. Expõe POST /execute (start/stop/restart/status) autenticado por secret
 *  2. Envia heartbeat periódico para o master (ou atualiza localmente se for o master)
 *  3. Executa start/stop via processManager local
 *
 * Uso:
 *   NODE_ROLE=worker NODE_ID=node-2 NODE_SECRET=xxx MASTER_URL=http://master:3001 node index.js
 * ou apenas require + startWorkerAgent() no boot.
 */
const express = require('express');
const axios = require('axios');
const os = require('os');
const si = require('systeminformation');

let server = null;
let heartbeatTimer = null;

function getLocalStatsSync() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    return {
        total_ram: Math.round(totalMem / 1024 / 1024),
        used_ram: Math.round((totalMem - freeMem) / 1024 / 1024),
        total_cpu: 100,
        used_cpu: Math.round((os.loadavg()[0] / (os.cpus().length || 1)) * 100),
    };
}

async function getLocalStats() {
    try {
        const [load, mem] = await Promise.all([si.currentLoad(), si.mem()]);
        return {
            total_ram: Math.round(mem.total / 1024 / 1024),
            used_ram: Math.round(mem.active / 1024 / 1024),
            total_cpu: 100,
            used_cpu: Math.round(load.currentLoad),
        };
    } catch {
        return getLocalStatsSync();
    }
}

/**
 * Inicia o agente HTTP do worker.
 */
function startWorkerAgent(options = {}) {
    const port = Number(options.port || process.env.WORKER_PORT || 3002);
    const nodeId = options.nodeId || process.env.NODE_ID || 'worker-1';
    const secret = options.secret || process.env.NODE_SECRET || 'change-me';
    const masterUrl = options.masterUrl || process.env.MASTER_URL || null;

    if (secret === 'change-me' || secret.length < 8) {
        console.warn('[WORKER] NODE_SECRET fraco ou padrão — defina um segredo forte.');
    }

    const app = express();
    app.use(express.json({ limit: '1mb' }));

    // Auth por secret compartilhado
    app.use((req, res, next) => {
        if (req.path === '/health') return next();
        const provided = req.body?.secret || req.headers['x-node-secret'];
        if (provided !== secret) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        next();
    });

    app.get('/health', (_req, res) => {
        res.json({ ok: true, nodeId, role: 'worker', uptime: process.uptime() });
    });

    app.post('/execute', async (req, res) => {
        const { action, data } = req.body || {};
        try {
            const {
                startBot, stopBot, restartBot, getBotStats, getOnlineBots,
            } = require('./processManager');

            switch (action) {
                case 'start':
                    await startBot(data.botId);
                    return res.json({ success: true, action: 'start', botId: data.botId });
                case 'stop':
                    stopBot(data.botId);
                    return res.json({ success: true, action: 'stop', botId: data.botId });
                case 'restart':
                    await restartBot(data.botId);
                    return res.json({ success: true, action: 'restart', botId: data.botId });
                case 'status': {
                    const online = getOnlineBots();
                    const stats = data.botId ? await getBotStats(data.botId) : null;
                    return res.json({ success: true, online, stats });
                }
                case 'ping':
                    return res.json({ success: true, nodeId, stats: await getLocalStats() });
                default:
                    return res.status(400).json({ error: `Ação desconhecida: ${action}` });
            }
        } catch (err) {
            console.error(`[WORKER] Erro em /execute (${action}):`, err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    server = app.listen(port, () => {
        console.log(`[WORKER] Agente multi-node ouvindo na porta ${port} (nodeId=${nodeId})`);
    });

    // Heartbeat para o master (se configurado)
    if (masterUrl) {
        const beat = async () => {
            try {
                const stats = await getLocalStats();
                await axios.post(
                    `${masterUrl.replace(/\/$/, '')}/node-heartbeat`,
                    { nodeId, secret, stats },
                    { timeout: 5000 }
                );
            } catch (err) {
                // Master offline — só loga de vez em quando
                if (Math.random() < 0.1) {
                    console.warn(`[WORKER] Heartbeat falhou: ${err.message}`);
                }
            }
        };
        beat();
        heartbeatTimer = setInterval(beat, 30 * 1000);
        heartbeatTimer.unref?.();
    } else {
        // Sem master remoto: atualiza heartbeat local no próprio banco
        const { updateNodeHeartbeat, registerNode } = require('./nodeManager');
        registerNode({
            id: nodeId,
            name: process.env.NODE_NAME || nodeId,
            ip: process.env.NODE_IP || '127.0.0.1',
            port,
            secret_key: secret,
        });
        const beatLocal = async () => {
            try {
                updateNodeHeartbeat(nodeId, await getLocalStats());
            } catch { /* ignore */ }
        };
        beatLocal();
        heartbeatTimer = setInterval(beatLocal, 30 * 1000);
        heartbeatTimer.unref?.();
    }

    return { port, nodeId };
}

function stopWorkerAgent() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (server) {
        server.close();
        server = null;
    }
}

module.exports = { startWorkerAgent, stopWorkerAgent, getLocalStats };
