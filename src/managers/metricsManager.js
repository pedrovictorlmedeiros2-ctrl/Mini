const fs = require('fs');
const path = require('path');
const { get } = require('../database/database');

const metricsFile = path.join(process.cwd(), 'logs', 'metrics.json');
const HISTORY_LIMIT = 1000;

function loadMetrics() {
    try {
        if (!fs.existsSync(metricsFile)) return [];
        const raw = fs.readFileSync(metricsFile, 'utf8');
        return JSON.parse(raw);
    } catch {
        return [];
    }
}

function saveMetrics(items) {
    try {
        const dir = path.dirname(metricsFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(metricsFile, JSON.stringify(items.slice(-HISTORY_LIMIT), null, 2));
    } catch {
        // best effort
    }
}

function recordMetric(name, value, metadata = {}) {
    const metrics = loadMetrics();
    metrics.push({
        ts: new Date().toISOString(),
        name,
        value,
        metadata,
    });
    saveMetrics(metrics);
}

function getMetricsSummary() {
    const metrics = loadMetrics();
    const byName = new Map();
    for (const item of metrics) {
        if (!byName.has(item.name)) byName.set(item.name, []);
        byName.get(item.name).push(item);
    }

    const summary = {};
    for (const [name, entries] of byName) {
        const values = entries.map(e => Number(e.value) || 0);
        summary[name] = {
            count: values.length,
            last: values.at(-1) || 0,
            avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0,
        };
    }
    return summary;
}

function collectSystemMetrics() {
    // CORREÇÃO: usava query() (retorna um ARRAY de linhas via .all()) e lia
    // `.count` direto no array — arrays não têm essa propriedade, então
    // totalBots/onlineBots eram sempre `undefined`. Toda métrica registrada
    // virava 0 depois de Number(undefined) || 0 em getMetricsSummary(), então
    // a linha "📈 Métricas" do /painel sempre mostrava 0/0 bots, não importa
    // quantos estivessem realmente rodando. get() retorna a linha única certa.
    const totalBots = get('SELECT COUNT(*) as count FROM bots').count;
    const onlineBots = get("SELECT COUNT(*) as count FROM bots WHERE status = 'online'").count;
    recordMetric('bot_total', totalBots, { online: onlineBots });
    recordMetric('bot_online', onlineBots);
}

module.exports = { recordMetric, getMetricsSummary, collectSystemMetrics };
