const express = require('express');
const { collectRuntimeSnapshot } = require('../utils/diagnostics');
const { getReadinessState, STATUS: READINESS_STATUS } = require('./serviceReadiness');

let server = null;

function startHealthEndpoint(port = 3001) {
    const app = express();
    app.set('query parser', 'simple'); // mitigação de CVE moderado em `qs`, ver proxyManager.js
    app.disable('x-powered-by');
    const bindHost = process.env.HEALTH_HOST || '0.0.0.0';
    app.use(express.json({ limit: '256kb' }));

    app.get('/health', (req, res) => {
        res.json({
            ok: true,
            service: 'atlantic-host',
            version: require('../../package.json').version,
            timestamp: new Date().toISOString(),
            runtime: collectRuntimeSnapshot(),
            containers: String(process.env.USE_CONTAINERS || '') === 'true',
            readiness: getReadinessState(),
        });
    });

    // CORREÇÃO (readiness real): antes retornava {ready:true} incondicional
    // — um supervisor/monitor externo checando este endpoint nunca saberia
    // que o serviço está BLOCKED (sem isolamento forte disponível em
    // produção, ou diretório essencial não gravável). Agora reflete o
    // estado de verdade, com 503 quando BLOCKED — o bot de controle do
    // Discord continua respondendo mesmo assim, isto é só sobre
    // provisionamento/hospedagem.
    app.get('/ready', (req, res) => {
        const readiness = getReadinessState();
        const httpStatus = readiness.status === READINESS_STATUS.BLOCKED ? 503 : 200;
        res.status(httpStatus).json({
            ok: readiness.status !== READINESS_STATUS.BLOCKED,
            ready: readiness.status !== READINESS_STATUS.BLOCKED,
            status: readiness.status,
            blockedReasons: readiness.blockedReasons,
            degradedReasons: readiness.degradedReasons,
            checkedAt: readiness.checkedAt,
            timestamp: new Date().toISOString(),
        });
    });

    // Heartbeat de nodes escravos (multi-node)
    app.post('/node-heartbeat', (req, res) => {
        try {
            const { nodeId, secret, stats } = req.body || {};
            if (!nodeId || !secret) {
                return res.status(400).json({ error: 'nodeId e secret obrigatórios' });
            }
            const { get, run } = require('../database/database');
            const node = get('SELECT * FROM nodes WHERE id = ?', [nodeId]);
            if (!node || node.secret_key !== secret) {
                return res.status(401).json({ error: 'unauthorized' });
            }
            const { updateNodeHeartbeat } = require('./nodeManager');
            updateNodeHeartbeat(nodeId, stats || {});
            return res.json({ ok: true });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    // Prometheus exposition
    app.get('/metrics', (req, res) => {
        try {
            const { collectPrometheusMetrics } = require('./prometheusMetrics');
            res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
            res.send(collectPrometheusMetrics());
        } catch (err) {
            res.status(500).send(`# error ${err.message}\n`);
        }
    });

    // Métricas da fila
    app.get('/queue', (req, res) => {
        try {
            const { getQueueMetrics } = require('./queueManager');
            res.json(getQueueMetrics());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    server = app.listen(port, bindHost, () => {
        console.log(`🩺 Health endpoint ativo em http://${bindHost}:${port}`);
    });
}

function stopHealthEndpoint() {
    if (server) {
        server.close();
        server = null;
    }
}

module.exports = { startHealthEndpoint, stopHealthEndpoint };
