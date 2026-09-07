const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-quarantineManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get } = require('../src/database/database');
initDatabase();

const config = require('../config');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-quarantine-test-'));
config.system.quarantineFolder = path.join(tmpRoot, 'quarantine');

const { quarantine } = require('../src/managers/security/QuarantineManager');

let counter = 0;
function makeBotWithFolder(label) {
    counter += 1;
    const botId = `qtest-${label}-${counter}`;
    const userId = `${botId}-owner`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    const folderPath = path.join(tmpRoot, 'bots', botId);
    fs.mkdirSync(folderPath, { recursive: true });
    fs.writeFileSync(path.join(folderPath, 'index.js'), `console.log('${botId}')`);
    run(
        "INSERT INTO bots (id, code, name, creator_id, folder_path) VALUES (?, ?, ?, ?, ?)",
        [botId, botId, 'Bot Teste', userId, folderPath]
    );
    return get('SELECT * FROM bots WHERE id = ?', [botId]);
}

function makeIncident(botId) {
    const r = run(
        "INSERT INTO incidents (bot_id, severity, status, evidence_json) VALUES (?, 'CRITICAL', 'quarantining', '{}')",
        [botId]
    );
    return r.lastInsertRowid;
}

test('quarantine() move a pasta pra fora (conteúdo intacto), suspende o bot e grava quarantine_entries', () => {
    const bot = makeBotWithFolder('basic');
    const incidentId = makeIncident(bot.id);

    const result = quarantine(bot, incidentId);

    assert.ok(result.quarantineEntryId);
    assert.ok(fs.existsSync(result.quarantinePath));
    assert.equal(fs.existsSync(bot.folder_path), false, 'pasta original não deveria mais existir no caminho antigo');
    assert.equal(
        fs.readFileSync(path.join(result.quarantinePath, 'index.js'), 'utf8'),
        `console.log('${bot.id}')`,
        'conteúdo deveria estar intacto no destino — mover, nunca apagar'
    );

    const updatedBot = get('SELECT * FROM bots WHERE id = ?', [bot.id]);
    assert.equal(updatedBot.suspended, 1);
    assert.match(updatedBot.suspended_reason, new RegExp(`#${incidentId}`));

    const entry = get('SELECT * FROM quarantine_entries WHERE id = ?', [result.quarantineEntryId]);
    assert.equal(entry.bot_id, bot.id);
    assert.equal(entry.incident_id, incidentId);
    assert.equal(entry.purged, 0);
    assert.ok(entry.retention_until);
});

test('quarantine() de um bot sem pasta (já removida por outro motivo) não lança, e ainda suspende o bot', () => {
    const bot = makeBotWithFolder('nofolder');
    fs.rmSync(bot.folder_path, { recursive: true, force: true });
    const incidentId = makeIncident(bot.id);

    const result = quarantine(bot, incidentId);
    assert.equal(result.quarantinePath, null);
    assert.equal(result.quarantineEntryId, null);

    const updatedBot = get('SELECT * FROM bots WHERE id = ?', [bot.id]);
    assert.equal(updatedBot.suspended, 1, 'mesmo sem pasta, o bot ainda deve ficar suspenso (bloqueia restart concorrente)');
});

test('ISOLAMENTO: quarentena de um bot nunca afeta a pasta nem o registro de outro bot (tenant vizinho)', () => {
    const botA = makeBotWithFolder('tenantA');
    const botB = makeBotWithFolder('tenantB');
    const incidentIdA = makeIncident(botA.id);

    const beforeBContent = fs.readFileSync(path.join(botB.folder_path, 'index.js'), 'utf8');

    quarantine(botA, incidentIdA);

    assert.ok(fs.existsSync(botB.folder_path), 'pasta do bot B não deveria ter sido tocada');
    assert.equal(fs.readFileSync(path.join(botB.folder_path, 'index.js'), 'utf8'), beforeBContent);

    const updatedB = get('SELECT * FROM bots WHERE id = ?', [botB.id]);
    assert.equal(updatedB.suspended, 0, 'bot B não deveria ter sido suspenso por um incidente do bot A');

    const entriesForB = get('SELECT COUNT(*) as total FROM quarantine_entries WHERE bot_id = ?', [botB.id]);
    assert.equal(entriesForB.total, 0);
});
