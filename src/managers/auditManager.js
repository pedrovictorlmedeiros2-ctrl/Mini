const { run, query } = require('../database/database');

function ensureAuditTable() {
    run(`
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            action TEXT NOT NULL,
            details TEXT,
            severity TEXT DEFAULT 'info',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    run('CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)');
}

function recordAuditEvent({ userId = null, event, details = '', severity = 'info' }) {
    ensureAuditTable();
    run('INSERT INTO audit_log (user_id, action, details, severity) VALUES (?, ?, ?, ?)', [userId, event, details, severity]);
    return true;
}

function getRecentAuditEvents(limit = 50) {
    ensureAuditTable();
    return query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?', [limit]);
}

module.exports = { recordAuditEvent, getRecentAuditEvents, ensureAuditTable };
