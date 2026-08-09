const { DatabaseSync } = require('node:sqlite');

function createDatabaseConnection(filePath) {
    const db = new DatabaseSync(filePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');

    const originalExec = db.exec.bind(db);
    db.exec = (sql) => originalExec(sql);

    return db;
}

module.exports = { createDatabaseConnection };
