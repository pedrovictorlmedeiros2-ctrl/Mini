const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-console.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { addLog, getRecentLogs } = require('../src/managers/consoleManager');

test('addLog atualiza o buffer em memória e é lido por getRecentLogs', () => {
    addLog('bot-console-test-1', 'primeira linha', 'stdout');
    const logs = getRecentLogs('bot-console-test-1');
    assert.ok(logs.includes('primeira linha'));
});
