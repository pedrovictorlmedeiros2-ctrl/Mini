const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-serviceReadinessEnforcement.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run } = require('../src/database/database');
initDatabase();

const config = require('../config');
const { computeReadiness, STATUS } = require('../src/managers/serviceReadiness');
const { startBot } = require('../src/managers/processManager');
const { installDependencies } = require('../src/managers/dependencyManager');

// FASE 9: computeReadiness() agora dispara alertManager.sendAlert()/
// clientRef.tryDM() em toda mudança de estado — este arquivo também seta
// LOG_WEBHOOK_URL com um domínio real (discord.com, só com IDs falsos)
// pra simular "webhook configurado". Sem este stub, os testes abaixo
// disparariam uma chamada de rede real. Nenhuma asserção existente
// depende do comportamento de sendAlert()/tryDM(), então interceptar
// aqui não muda nada do que já era testado.
const alertManager = require('../src/managers/alertManager');
const clientRef = require('../src/utils/clientRef');
alertManager.sendAlert = async () => {};
clientRef.tryDM = async () => true;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-readiness-enforcement-'));

run(`INSERT INTO users (id, username, role) VALUES ('owner-readiness-test', 'tester', 'client')`);

function makeBotFolder() {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'bot-'));
    fs.writeFileSync(path.join(dir, 'index.js'), "console.log('ok')");
    return dir;
}

let counter = 0;
function insertBot(folderPath) {
    counter += 1;
    const botId = `readiness-enforce-${counter}`;
    run(
        `INSERT INTO bots (id, code, name, creator_id, folder_path, status, language, auto_restart)
         VALUES (?, ?, ?, 'owner-readiness-test', ?, 'offline', 'javascript', 0)`,
        [botId, 'CODE-' + botId, 'Bot ' + botId, folderPath]
    );
    return botId;
}

async function forceBlocked() {
    // Diretório essencial impossível de criar — determinístico, não
    // depende de nenhuma capacidade real do host.
    const blockerFile = path.join(tmpRoot, 'blocker-file');
    if (!fs.existsSync(blockerFile)) fs.writeFileSync(blockerFile, 'x');
    config.system.quarantineFolder = path.join(blockerFile, 'quarantine');
    config.system.botsFolder = path.join(tmpRoot, 'blocked', 'bots');
    config.system.backupsFolder = path.join(tmpRoot, 'blocked', 'backups');
    config.system.logsFolder = path.join(tmpRoot, 'blocked', 'logs');
    process.env.REQUIRE_LINUX_SANDBOX = 'false';
    const result = await computeReadiness();
    assert.equal(result.status, STATUS.BLOCKED, 'pré-condição do teste: precisa estar BLOCKED');
}

async function forceReady() {
    const goodRoot = path.join(tmpRoot, 'ready');
    config.system.botsFolder = path.join(goodRoot, 'bots');
    config.system.backupsFolder = path.join(goodRoot, 'backups');
    config.system.quarantineFolder = path.join(goodRoot, 'quarantine');
    config.system.logsFolder = path.join(goodRoot, 'logs');
    process.env.REQUIRE_LINUX_SANDBOX = 'false';
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/fake/fake';
    process.env.USE_CONTAINERS = 'false';
    const result = await computeReadiness();
    assert.notEqual(result.status, STATUS.BLOCKED, `pré-condição do teste: não pode estar BLOCKED, motivos: ${JSON.stringify(result)}`);
}

test('BLOQUEIO DE START: startBot() recusa com o serviço BLOCKED, nunca tenta subir o processo', async () => {
    await forceBlocked();
    const folderPath = makeBotFolder();
    const botId = insertBot(folderPath);

    await assert.rejects(
        () => startBot(botId),
        /BLOCKED/,
        'startBot() deveria recusar citando o estado BLOCKED, antes de qualquer tentativa de decidir backend ou spawnar processo'
    );
});

test('BLOQUEIO DE PROVISIONAMENTO: installDependencies() recusa com o serviço BLOCKED, nunca executa install/build', async () => {
    await forceBlocked();
    const folderPath = makeBotFolder();
    // package.json presente — se o gate não estivesse aplicado, isto
    // tentaria rodar um install de verdade.
    fs.writeFileSync(path.join(folderPath, 'package.json'), '{"name":"x","version":"1.0.0"}');
    const botId = insertBot(folderPath);

    await assert.rejects(
        () => installDependencies(botId, folderPath),
        /BLOCKED/
    );
});

test('Com o serviço READY, installDependencies() volta a funcionar normalmente (caminho sem dependências reconhecidas)', async () => {
    await forceReady();
    const folderPath = makeBotFolder(); // só index.js, sem package.json/requirements.txt
    const botId = insertBot(folderPath);

    const result = await installDependencies(botId, folderPath);
    assert.equal(result, true, 'sem arquivo de dependências reconhecido, deveria retornar true sem tentar instalar nada');
});
