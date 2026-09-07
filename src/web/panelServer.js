/**
 * PAINEL WEB — dashboard operacional + ações
 * Porta: WEB_PANEL_PORT (default 3080)
 * Auth: X-Panel-Token / Bearer  == WEB_PANEL_TOKEN
 *
 * Ações: start / stop / restart / logs (somente com token válido)
 */
const express = require('express');
const path = require('path');
const { extractProvidedToken, isValidPanelToken } = require('../utils/panelAuth');

let server = null;

function auth(req, res, next) {
    const expected = process.env.WEB_PANEL_TOKEN;
    if (!expected) {
        return res.status(503).json({ error: 'WEB_PANEL_TOKEN não configurado' });
    }
    // CORREÇÃO DE SEGURANÇA: ?token= na URL foi removido de propósito — query
    // strings costumam parar em logs de acesso, histórico do navegador,
    // proxies e ferramentas de monitoramento, vazando o token do painel.
    // Só header (X-Panel-Token ou Authorization: Bearer) é aceito agora.
    // Ver src/utils/panelAuth.js pros testes disso isolado (tests/panelAuth.test.js).
    const provided = extractProvidedToken(req.headers);
    if (!isValidPanelToken(provided, expected)) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

function resolveBot(idOrCode) {
    const { get } = require('../database/database');
    return get('SELECT * FROM bots WHERE id = ? OR code = ?', [idOrCode, idOrCode]);
}

function startWebPanel(port = Number(process.env.WEB_PANEL_PORT) || 3080) {
    if (String(process.env.WEB_PANEL_ENABLED || '').toLowerCase() !== 'true' &&
        process.env.WEB_PANEL_ENABLED !== '1') {
        console.log('[WEB] Painel web desabilitado (WEB_PANEL_ENABLED!=true).');
        return null;
    }

    const app = express();
    app.set('query parser', 'simple'); // mitigação de CVE moderado em `qs`, ver proxyManager.js
    app.disable('x-powered-by');
    const publicDir = path.join(__dirname, 'public');

    app.use(express.json({ limit: '256kb' }));
    app.use(express.static(publicDir));

    // ── Status agregado ──────────────────────────────────────────────────────
    app.get('/api/status', auth, async (req, res) => {
        try {
            const { get, query } = require('../database/database');
            const { getQueueMetrics } = require('../managers/queueManager');
            const { getOnlineBots, getSystemStats } = require('../managers/processManager');
            const { listNodesHealth } = require('../managers/nodeManager');
            const { getMetricsSummary } = require('../managers/metricsManager');

            const totalBots = get('SELECT COUNT(*) as c FROM bots').c;
            const onlineBots = get("SELECT COUNT(*) as c FROM bots WHERE status = 'online'").c;
            const suspended = get('SELECT COUNT(*) as c FROM bots WHERE suspended = 1').c;
            const users = get('SELECT COUNT(*) as c FROM users').c;
            const openOrders = get(
                "SELECT COUNT(*) as c FROM orders WHERE status IN ('pending','waiting_payment','in_analysis')"
            ).c;

            const bots = query(
                `SELECT id, code, name, status, type, language, port, cpu_usage, ram_usage, node_id,
                        health_status, last_start, suspended
                 FROM bots ORDER BY status DESC, name ASC LIMIT 200`
            );

            let system = null;
            try { system = await getSystemStats(); } catch { /* ignore */ }

            res.json({
                ok: true,
                version: require('../../package.json').version,
                uptime: process.uptime(),
                counts: { totalBots, onlineBots, suspended, users, openOrders },
                queue: getQueueMetrics(),
                nodes: listNodesHealth(),
                onlineIds: getOnlineBots(),
                bots,
                system,
                metrics: getMetricsSummary(),
                features: {
                    containers: String(process.env.USE_CONTAINERS || '') === 'true',
                    failover: String(process.env.FAILOVER_ENABLED || '') === 'true',
                    offsite: String(process.env.OFFSITE_BACKUP_ENABLED || '') === 'true',
                },
                ts: new Date().toISOString(),
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/api/bot/:id', auth, (req, res) => {
        try {
            const bot = resolveBot(req.params.id);
            if (!bot) return res.status(404).json({ error: 'not found' });
            delete bot.token;
            res.json(bot);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Ações ────────────────────────────────────────────────────────────────
    app.post('/api/bot/:id/start', auth, async (req, res) => {
        try {
            const bot = resolveBot(req.params.id);
            if (!bot) return res.status(404).json({ error: 'Bot não encontrado' });
            if (bot.suspended) return res.status(403).json({ error: 'Bot suspenso' });
            const { startBot } = require('../managers/processManager');
            const { logAction } = require('../managers/logManager');
            await startBot(bot.id);
            logAction(bot.id, null, 'WEB_START', 'Iniciado via painel web');
            res.json({ ok: true, action: 'start', botId: bot.id, code: bot.code });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.post('/api/bot/:id/stop', auth, async (req, res) => {
        try {
            const bot = resolveBot(req.params.id);
            if (!bot) return res.status(404).json({ error: 'Bot não encontrado' });
            const { stopBot } = require('../managers/processManager');
            const { logAction } = require('../managers/logManager');
            stopBot(bot.id);
            logAction(bot.id, null, 'WEB_STOP', 'Parado via painel web');
            res.json({ ok: true, action: 'stop', botId: bot.id, code: bot.code });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.post('/api/bot/:id/restart', auth, async (req, res) => {
        try {
            const bot = resolveBot(req.params.id);
            if (!bot) return res.status(404).json({ error: 'Bot não encontrado' });
            if (bot.suspended) return res.status(403).json({ error: 'Bot suspenso' });
            const { restartBot } = require('../managers/processManager');
            const { logAction } = require('../managers/logManager');
            await restartBot(bot.id);
            logAction(bot.id, null, 'WEB_RESTART', 'Reiniciado via painel web');
            res.json({ ok: true, action: 'restart', botId: bot.id, code: bot.code });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.get('/api/bot/:id/logs', auth, async (req, res) => {
        try {
            const bot = resolveBot(req.params.id);
            if (!bot) return res.status(404).json({ error: 'Bot não encontrado' });
            const lines = Math.min(parseInt(req.query.lines, 10) || 80, 500);
            const { getRecentLogs } = require('../managers/consoleManager');
            let text = '';
            try {
                text = getRecentLogs(bot.id) || '';
            } catch {
                text = '';
            }
            // Fallback container logs
            if (!text) {
                try {
                    const containerMgr = require('../managers/containerManager');
                    if (containerMgr.containersEnabled()) {
                        const cLogs = await containerMgr.getContainerLogs(bot.id, lines);
                        if (cLogs) text = cLogs;
                    }
                } catch { /* ignore */ }
            }
            if (text.length > 20000) text = text.slice(-20000);
            res.json({ ok: true, botId: bot.id, code: bot.code, logs: text });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    const bind = process.env.WEB_PANEL_HOST || '0.0.0.0';
    server = app.listen(port, bind, () => {
        console.log(`🌐 Painel web em http://${bind}:${port} (auth WEB_PANEL_TOKEN)`);
    });
    return server;
}

function stopWebPanel() {
    if (server) {
        server.close();
        server = null;
    }
}

module.exports = { startWebPanel, stopWebPanel };
