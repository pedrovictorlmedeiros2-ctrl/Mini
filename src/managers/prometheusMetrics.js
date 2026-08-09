/**
 * MÉTRICAS PROMETHEUS — formato text/plain exposition
 * Endpoint: GET /metrics
 *
 * Coleta gauges/counters a partir do estado ao vivo do painel
 * (sem dependência externa de client Prometheus).
 */
const os = require('os');
const { get, query } = require('../database/database');

function escapeLabel(v) {
    return String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function line(name, value, labels = {}) {
    const keys = Object.keys(labels);
    if (keys.length === 0) return `${name} ${value}`;
    const lbl = keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(',');
    return `${name}{${lbl}} ${value}`;
}

function collectPrometheusMetrics() {
    const lines = [];
    const help = (name, text, type = 'gauge') => {
        lines.push(`# HELP ${name} ${text}`);
        lines.push(`# TYPE ${name} ${type}`);
    };

    // ── Processo do painel ──
    help('hosting_panel_uptime_seconds', 'Uptime do processo do painel');
    lines.push(line('hosting_panel_uptime_seconds', process.uptime().toFixed(1)));

    help('hosting_panel_memory_rss_bytes', 'RSS do painel');
    lines.push(line('hosting_panel_memory_rss_bytes', process.memoryUsage().rss));

    help('hosting_panel_memory_heap_bytes', 'Heap usado do painel');
    lines.push(line('hosting_panel_memory_heap_bytes', process.memoryUsage().heapUsed));

    // ── Host ──
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    help('hosting_host_memory_total_bytes', 'RAM total do host');
    lines.push(line('hosting_host_memory_total_bytes', totalMem));
    help('hosting_host_memory_free_bytes', 'RAM livre do host');
    lines.push(line('hosting_host_memory_free_bytes', freeMem));
    help('hosting_host_load1', 'Load average 1m');
    lines.push(line('hosting_host_load1', os.loadavg()[0].toFixed(3)));

    // ── Bots ──
    let totalBots = 0;
    let onlineBots = 0;
    let suspendedBots = 0;
    try {
        totalBots = get('SELECT COUNT(*) as c FROM bots').c;
        onlineBots = get("SELECT COUNT(*) as c FROM bots WHERE status = 'online'").c;
        suspendedBots = get('SELECT COUNT(*) as c FROM bots WHERE suspended = 1').c;
    } catch { /* db offline during boot */ }

    help('hosting_bots_total', 'Total de bots cadastrados');
    lines.push(line('hosting_bots_total', totalBots));
    help('hosting_bots_online', 'Bots online');
    lines.push(line('hosting_bots_online', onlineBots));
    help('hosting_bots_suspended', 'Bots suspensos');
    lines.push(line('hosting_bots_suspended', suspendedBots));

    // Por linguagem
    try {
        const byLang = query('SELECT language, COUNT(*) as c FROM bots GROUP BY language');
        help('hosting_bots_by_language', 'Bots por linguagem');
        for (const row of byLang) {
            lines.push(line('hosting_bots_by_language', row.c, { language: row.language || 'unknown' }));
        }
    } catch { /* ignore */ }

    // Recursos reportados
    try {
        const resources = query(
            "SELECT id, code, cpu_usage, ram_usage, status FROM bots WHERE status = 'online'"
        );
        help('hosting_bot_cpu_percent', 'CPU % por bot online');
        help('hosting_bot_ram_mb', 'RAM MB por bot online');
        for (const b of resources) {
            const labels = { bot_id: b.id, code: b.code || b.id };
            lines.push(line('hosting_bot_cpu_percent', Number(b.cpu_usage) || 0, labels));
            lines.push(line('hosting_bot_ram_mb', Number(b.ram_usage) || 0, labels));
        }
    } catch { /* ignore */ }

    // ── Nodes ──
    try {
        const nodes = query('SELECT id, name, status, used_ram, used_cpu FROM nodes');
        help('hosting_nodes_up', 'Node online (1) ou offline (0)');
        for (const n of nodes) {
            lines.push(line('hosting_nodes_up', n.status === 'online' ? 1 : 0, {
                node_id: n.id,
                name: n.name || n.id,
            }));
        }
    } catch { /* ignore */ }

    // ── Fila ──
    try {
        const { getQueueMetrics } = require('./queueManager');
        const q = getQueueMetrics();
        help('hosting_queue_size', 'Tarefas na fila');
        lines.push(line('hosting_queue_size', q.queued || 0));
        help('hosting_queue_active', 'Tarefas ativas');
        lines.push(line('hosting_queue_active', q.active || 0));
        help('hosting_queue_processed_total', 'Tarefas processadas', 'counter');
        lines.push(line('hosting_queue_processed_total', q.processed || 0));
        help('hosting_queue_failed_total', 'Tarefas falhas', 'counter');
        lines.push(line('hosting_queue_failed_total', q.failed || 0));
    } catch { /* ignore */ }

    // ── Pedidos ──
    try {
        const pending = get("SELECT COUNT(*) as c FROM orders WHERE status IN ('pending','waiting_payment','in_analysis')").c;
        help('hosting_orders_open', 'Pedidos em aberto');
        lines.push(line('hosting_orders_open', pending));
    } catch { /* ignore */ }

    lines.push(''); // newline final exigido pelo Prometheus
    return lines.join('\n');
}

module.exports = { collectPrometheusMetrics };
