const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-maintenanceManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, query, get } = require('../src/database/database');
initDatabase();

const { pruneOldBackups } = require('../src/managers/maintenanceManager');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-maint-test-'));

let counter = 0;
function makeBot() {
    counter += 1;
    const botId = `mainttest-bot-${counter}`;
    const userId = `mainttest-user-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    run(
        "INSERT INTO bots (id, code, name, creator_id, folder_path) VALUES (?, ?, ?, ?, ?)",
        [botId, botId, 'Bot Teste', userId, `/tmp/${botId}`]
    );
    return botId;
}

function insertBackup(botId, ageDays) {
    const filePath = path.join(tmpRoot, `${botId}-${ageDays}d.zip.enc`);
    fs.writeFileSync(filePath, 'conteudo-fake-do-backup');
    const createdAt = `datetime('now', '-${ageDays} days')`;
    const result = run(
        `INSERT INTO backups (bot_id, file_path, size, type, checksum, encrypted, created_at)
         VALUES (?, ?, 0, 'manual', 'x', 1, ${createdAt})`,
        [botId, filePath]
    );
    return { id: result.lastInsertRowid, filePath };
}

test('CORREÇÃO DE SEGURANÇA (gap de retenção): bot com um ÚNICO backup de 40 dias sobrevive à limpeza automática', () => {
    const botId = makeBot();
    const backup = insertBackup(botId, 40);

    const removed = pruneOldBackups();

    assert.equal(removed, 0, 'nenhum backup deveria ter sido removido — é o único que o bot tem');
    const row = get('SELECT * FROM backups WHERE id = ?', [backup.id]);
    assert.ok(row, 'a linha do backup deveria continuar no banco');
    assert.ok(fs.existsSync(backup.filePath), 'o arquivo do backup deveria continuar existindo em disco');
});

test('bot com vários backups antigos: mantém pelo menos o mais recente, remove os demais', () => {
    const botId = makeBot();
    const oldest = insertBackup(botId, 90);
    const middle = insertBackup(botId, 60);
    const newest = insertBackup(botId, 35);

    const removed = pruneOldBackups();

    assert.equal(removed, 2, 'deveria remover os 2 mais antigos, preservando o mais recente');
    assert.equal(get('SELECT * FROM backups WHERE id = ?', [oldest.id]), undefined);
    assert.equal(get('SELECT * FROM backups WHERE id = ?', [middle.id]), undefined);
    assert.ok(get('SELECT * FROM backups WHERE id = ?', [newest.id]), 'o mais recente deveria ter sido preservado');
    assert.ok(fs.existsSync(newest.filePath));
});

test('backups recentes (< 30 dias) nunca são tocados, independente de quantos existirem', () => {
    const botId = makeBot();
    const recent1 = insertBackup(botId, 1);
    const recent2 = insertBackup(botId, 5);

    const removed = pruneOldBackups();

    assert.equal(removed, 0);
    assert.ok(get('SELECT * FROM backups WHERE id = ?', [recent1.id]));
    assert.ok(get('SELECT * FROM backups WHERE id = ?', [recent2.id]));
});

test('ISOLAMENTO: a limpeza de um bot nunca remove o único backup de OUTRO bot', () => {
    const botA = makeBot(); // só 1 backup velho — deve sobreviver
    const botB = makeBot(); // vários backups velhos — os excedentes podem ser removidos

    const onlyBackupA = insertBackup(botA, 45);
    insertBackup(botB, 90);
    insertBackup(botB, 80);
    const newestB = insertBackup(botB, 35);

    pruneOldBackups();

    assert.ok(get('SELECT * FROM backups WHERE id = ?', [onlyBackupA.id]), 'o único backup do bot A nunca deveria ser removido por causa do bot B');
    assert.ok(get('SELECT * FROM backups WHERE id = ?', [newestB.id]));

    const remainingA = query('SELECT * FROM backups WHERE bot_id = ?', [botA]);
    assert.equal(remainingA.length, 1);
});
