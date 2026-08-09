/**
 * MANUTENÇÃO AUTOMÁTICA — v2.0
 * Limpeza de artefatos, retenção de logs/histórico e saúde do SQLite.
 */
const fs = require('fs');
const path = require('path');
const { query, run, db } = require('../database/database');
const { addLog } = require('./consoleManager');
const { logSecurityEvent } = require('./logManager');
const config = require('../../config');

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1h
const LOG_RETENTION_DAYS = 14;
const ACTION_HISTORY_RETENTION_DAYS = 90;
const SYSTEM_LOGS_RETENTION_DAYS = 30;
const RECEIPT_RETENTION_DAYS = 60;

let cleanupTimer = null;

function ensureMaintenanceFolders() {
    const dirs = [
        path.join(process.cwd(), 'logs'),
        path.join(process.cwd(), 'logs', 'bots'),
        path.join(process.cwd(), 'backups'),
        path.resolve(config.system.receiptsFolder || './receipts'),
    ];
    for (const dir of dirs) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
}

function safeUnlink(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore */ }
}

function pruneOldFilesInDir(dir, maxAgeDays, extensions = null) {
    if (!fs.existsSync(dir)) return 0;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    try {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            try {
                const st = fs.statSync(full);
                if (!st.isFile()) continue;
                if (extensions && !extensions.some((ext) => name.endsWith(ext))) continue;
                if (st.mtimeMs < cutoff) {
                    fs.unlinkSync(full);
                    removed += 1;
                }
            } catch { /* ignore individual file errors */ }
        }
    } catch { /* ignore */ }
    return removed;
}

function pruneDatabaseHistory() {
    let deleted = 0;
    try {
        const r1 = run(
            `DELETE FROM action_history WHERE created_at < datetime('now', ?)`,
            [`-${ACTION_HISTORY_RETENTION_DAYS} days`]
        );
        deleted += r1?.changes || 0;

        const r2 = run(
            `DELETE FROM logs WHERE created_at < datetime('now', ?)`,
            [`-${SYSTEM_LOGS_RETENTION_DAYS} days`]
        );
        deleted += r2?.changes || 0;

        // Pedidos cancelados/antigos sem valor operacional
        const r3 = run(
            `DELETE FROM orders WHERE status IN ('cancelled', 'rejected') AND created_at < datetime('now', '-180 days')`
        );
        deleted += r3?.changes || 0;
    } catch (err) {
        console.warn('[MAINT] Erro ao limpar histórico do banco:', err.message);
    }
    return deleted;
}

function pruneStaleArtifacts() {
    let stats = { folders: 0, backups: 0, logs: 0, receipts: 0, dbRows: 0 };

    try {
        // Pastas vazias de bots offline
        const staleBots = query(
            "SELECT id, folder_path FROM bots WHERE status = 'offline' AND folder_path IS NOT NULL"
        );
        for (const bot of staleBots) {
            const folder = bot.folder_path;
            if (!folder || !fs.existsSync(folder)) continue;
            try {
                const files = fs.readdirSync(folder);
                if (files.length === 0) {
                    fs.rmSync(folder, { recursive: true, force: true });
                    run('UPDATE bots SET folder_path = ? WHERE id = ?', [null, bot.id]);
                    stats.folders += 1;
                }
            } catch { /* ignore */ }
        }

        // Backups > 30 dias
        const oldBackups = query(
            "SELECT id, file_path FROM backups WHERE created_at < datetime('now', '-30 days')"
        );
        for (const backup of oldBackups) {
            safeUnlink(backup.file_path);
            run('DELETE FROM backups WHERE id = ?', [backup.id]);
            stats.backups += 1;
        }

        // Logs de bots em disco
        const logsDir = path.join(process.cwd(), 'logs', 'bots');
        stats.logs = pruneOldFilesInDir(logsDir, LOG_RETENTION_DAYS, ['.log', '.old']);

        // Comprovantes antigos
        const receiptsDir = path.resolve(config.system.receiptsFolder || './receipts');
        stats.receipts = pruneOldFilesInDir(receiptsDir, RECEIPT_RETENTION_DAYS);

        // Histórico do banco
        stats.dbRows = pruneDatabaseHistory();

        // Saúde do SQLite
        try {
            db.exec('PRAGMA optimize');
            // VACUUM só a cada ~24h para não travar
            const lastVacuumFile = path.join(process.cwd(), 'logs', '.last-vacuum');
            let shouldVacuum = true;
            if (fs.existsSync(lastVacuumFile)) {
                const age = Date.now() - fs.statSync(lastVacuumFile).mtimeMs;
                if (age < 20 * 60 * 60 * 1000) shouldVacuum = false;
            }
            if (shouldVacuum) {
                db.exec('VACUUM');
                fs.writeFileSync(lastVacuumFile, new Date().toISOString());
                console.log('[MAINT] SQLite VACUUM executado.');
            }
        } catch (err) {
            console.warn('[MAINT] VACUUM/optimize falhou:', err.message);
        }

        console.log(
            `[MAINT] Limpeza: pastas=${stats.folders} backups=${stats.backups} ` +
            `logs=${stats.logs} receipts=${stats.receipts} dbRows=${stats.dbRows}`
        );
        addLog('system', `🧹 Manutenção concluída: ${JSON.stringify(stats)}`, 'stdout');
    } catch (err) {
        logSecurityEvent(null, 'maintenance_error', err.message);
        console.error('[MAINT] Erro na limpeza:', err.message);
    }

    return stats;
}

function startMaintenanceScheduler() {
    ensureMaintenanceFolders();
    if (cleanupTimer) clearInterval(cleanupTimer);

    // Roda uma vez após 2 min do boot (não competir com startup)
    setTimeout(() => {
        try { pruneStaleArtifacts(); } catch { /* ignore */ }
    }, 2 * 60 * 1000).unref?.();

    cleanupTimer = setInterval(() => {
        pruneStaleArtifacts();
    }, CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();

    console.log('🧹 Scheduler de manutenção iniciado (1h).');
}

function stopMaintenanceScheduler() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}

module.exports = {
    startMaintenanceScheduler,
    stopMaintenanceScheduler,
    pruneStaleArtifacts,
};
