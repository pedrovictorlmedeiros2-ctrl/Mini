const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-hosting.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, query, run, get } = require('../src/database/database');

test('initDatabase creates tables and supports basic CRUD', () => {
    initDatabase();
    run('INSERT INTO users (id, username, role) VALUES (?, ?, ?)', ['u1', 'tester', 'client']);
    const row = get('SELECT id, username, role FROM users WHERE id = ?', ['u1']);

    assert.ok(row);
    assert.strictEqual(row.username, 'tester');
    assert.strictEqual(row.role, 'client');

    const count = query('SELECT COUNT(*) as count FROM users').at(0).count;
    assert.strictEqual(count, 1);
});
