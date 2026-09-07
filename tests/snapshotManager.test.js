const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-snapshotManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run } = require('../src/database/database');
initDatabase();

const { findLastSafeSnapshot, findOpenIncidentId } = require('../src/managers/security/SnapshotManager');

let botCounter = 0;
function makeBot() {
    botCounter += 1;
    const botId = `snaptest-bot-${botCounter}`;
    const userId = `snaptest-user-${botCounter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    run(
        "INSERT INTO bots (id, code, name, creator_id, folder_path) VALUES (?, ?, ?, ?, ?)",
        [botId, botId, 'Bot Teste', userId, `/tmp/${botId}`]
    );
    return botId;
}

function insertBackup(botId, { createdAt, safetyStatus }) {
    run(
        `INSERT INTO backups (bot_id, file_path, size, type, checksum, encrypted, safety_status, created_at)
         VALUES (?, ?, 0, 'manual', 'x', 1, ?, ?)`,
        [botId, `/tmp/${botId}/backup-${createdAt}.zip.enc`, safetyStatus, createdAt]
    );
}

test('bot sem nenhum backup: findLastSafeSnapshot retorna null (fail-safe, nunca inventa restauração)', () => {
    const botId = makeBot();
    assert.equal(findLastSafeSnapshot(botId), null);
});

test('reproduz o exemplo do pedido original: #17 e #18 seguros, escolhe o mais recente seguro (#18), ignorando um mais novo comprometido', () => {
    const botId = makeBot();
    insertBackup(botId, { createdAt: '2024-01-01 00:00:17', safetyStatus: 'safe' });      // #17
    insertBackup(botId, { createdAt: '2024-01-01 00:00:18', safetyStatus: 'safe' });      // #18
    insertBackup(botId, { createdAt: '2024-01-01 00:00:19', safetyStatus: 'flagged_compromised' }); // #19 (não é o "current", mas simula um backup pós-incidente)

    const snapshot = findLastSafeSnapshot(botId);
    assert.ok(snapshot);
    assert.equal(snapshot.created_at, '2024-01-01 00:00:18', 'deveria escolher o #18 (mais recente SEGURO), nunca o #19 comprometido');
});

test('backup com safety_status desconhecido (dado legado/ambíguo) também é ignorado, não só o explicitamente comprometido', () => {
    const botId = makeBot();
    insertBackup(botId, { createdAt: '2024-01-01 00:00:01', safetyStatus: 'safe' });
    insertBackup(botId, { createdAt: '2024-01-01 00:00:02', safetyStatus: 'unknown' });

    const snapshot = findLastSafeSnapshot(botId);
    assert.ok(snapshot);
    assert.equal(snapshot.created_at, '2024-01-01 00:00:01');
});

test('bot com TODOS os backups comprometidos: findLastSafeSnapshot retorna null (nunca restaura de um backup não confiável)', () => {
    const botId = makeBot();
    insertBackup(botId, { createdAt: '2024-01-01 00:00:01', safetyStatus: 'flagged_compromised' });
    insertBackup(botId, { createdAt: '2024-01-01 00:00:02', safetyStatus: 'flagged_compromised' });

    assert.equal(findLastSafeSnapshot(botId), null);
});

test('findOpenIncidentId: null sem nenhum incidente; retorna o id enquanto o status não é terminal; volta a null após resolver', () => {
    const botId = makeBot();
    assert.equal(findOpenIncidentId(botId), null);

    const result = run(
        "INSERT INTO incidents (bot_id, severity, status, evidence_json) VALUES (?, 'CRITICAL', 'restoring', '{}')",
        [botId]
    );
    const incidentId = result.lastInsertRowid;
    assert.equal(findOpenIncidentId(botId), incidentId);

    run("UPDATE incidents SET status = 'resolved' WHERE id = ?", [incidentId]);
    assert.equal(findOpenIncidentId(botId), null);
});

test('findLastSafeSnapshot nunca mistura backups de bots diferentes', () => {
    const botA = makeBot();
    const botB = makeBot();
    insertBackup(botA, { createdAt: '2024-01-01 00:00:01', safetyStatus: 'safe' });
    insertBackup(botB, { createdAt: '2024-01-01 00:00:02', safetyStatus: 'safe' });

    const snapshotA = findLastSafeSnapshot(botA);
    assert.equal(snapshotA.bot_id, botA);
});
