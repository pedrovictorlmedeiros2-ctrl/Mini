const test = require('node:test');
const { before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Teste de integração de ponta a ponta: chama startBot()/stopBot() DE
// VERDADE (não as peças isoladas), pra provar que a fiação real do
// SandboxManager dentro de processManager.js funciona — não só que as
// classes isoladas funcionam.

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-process-sandbox-integration.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run } = require('../src/database/database');
initDatabase();

const { startBot, stopBot, activeProcesses } = require('../src/managers/processManager');
const { detectCapabilities } = require('../src/managers/sandbox/capabilityDetector');
const config = require('../config');
const { computeReadiness } = require('../src/managers/serviceReadiness');

run(`INSERT INTO users (id, username, role) VALUES ('creator-teste', 'lab-creator', 'client')`);

// PRÉ-REQUISITO (readiness gate): startBot() agora recusa de cara se o
// serviço estiver BLOCKED (default de arranque, fail-closed, ver
// serviceReadiness.js) — sem isto, os testes abaixo nunca chegariam a
// exercitar o fail-closed ESPECÍFICO do SandboxManager, que é o que este
// arquivo testa. Aponta os diretórios pra um tmp gravável e desliga a
// exigência de isolamento forte (REQUIRE_LINUX_SANDBOX=false) só pra não
// confundir o gate de SERVIÇO com o fail-closed POR BOT que já é o
// assunto deste arquivo.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-pmintegration-readiness-'));
config.system.botsFolder = path.join(tmpRoot, 'bots');
config.system.backupsFolder = path.join(tmpRoot, 'backups');
config.system.quarantineFolder = path.join(tmpRoot, 'quarantine');
config.system.logsFolder = path.join(tmpRoot, 'logs');
process.env.REQUIRE_LINUX_SANDBOX = 'false';
before(async () => { await computeReadiness(); });

function makeBotFolder() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-sandbox-integration-'));
    fs.writeFileSync(path.join(dir, 'index.js'), "console.log('BOT_INTEGRATION_OK'); setInterval(() => {}, 1000);");
    return dir;
}

function insertBot(id, folderPath) {
    run(
        `INSERT INTO bots (id, code, name, creator_id, folder_path, status, language, auto_restart, max_memory, max_cpu_limit)
         VALUES (?, ?, ?, ?, ?, 'offline', 'javascript', 0, 128, 20)`,
        [id, 'CODE-' + id, 'Bot de teste ' + id, 'creator-teste', folderPath]
    );
}

function withFakePlatform(fakePlatform, fn) {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: fakePlatform, configurable: true });
    return Promise.resolve()
        .then(fn)
        .finally(() => Object.defineProperty(process, 'platform', original));
}

test('startBot() recusa (fail-closed) quando este host Linux não tem sandbox real disponível', async () => {
    const caps = detectCapabilities();
    if (!caps.isLinux || caps.linuxSandboxReady) return; // só faz sentido neste cenário específico
    const folderPath = makeBotFolder();
    const botId = 'integration-failclosed';
    insertBot(botId, folderPath);

    await assert.rejects(() => startBot(botId), /Sandbox Linux indisponível/);
    assert.equal(activeProcesses.has(botId), false, 'não deveria ter registrado processo nenhum quando falha fechado');
});

test('startBot()/stopBot() de ponta a ponta via ProcessSandboxBackend (simulando Windows)', async () => {
    await withFakePlatform('win32', async () => {
        const folderPath = makeBotFolder();
        const botId = 'integration-process-backend';
        insertBot(botId, folderPath);

        await startBot(botId);
        assert.ok(activeProcesses.has(botId), 'bot deveria estar no mapa de processos ativos depois de startBot()');

        const entry = activeProcesses.get(botId);
        assert.ok(entry.sandbox, 'entry deveria ter uma instância de sandbox associada');
        assert.equal(entry.sandbox.status().backend, 'process');
        assert.equal(entry.sandbox.status().reduced, true);

        // dá tempo do processo real escrever no console
        await new Promise((r) => setTimeout(r, 500));
        const logs = entry.sandbox.logs().map((l) => l.line).join('');
        assert.ok(logs.includes('BOT_INTEGRATION_OK'), `esperava ver a saída do bot real, log: ${logs}`);

        stopBot(botId);
        // stopBot() é síncrono mas a limpeza de fato é assíncrona (destroy())
        const deadline = Date.now() + 5000;
        while (activeProcesses.has(botId) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(activeProcesses.has(botId), false, 'bot deveria ter saído do mapa depois do stopBot() terminar de verdade');
    });
});

test('startBot()/stopBot() de ponta a ponta via LinuxSandboxBackend real (só roda se este host suportar de verdade)', { skip: !detectCapabilities().linuxSandboxReady ? 'requer cgroup v2 delegado — não disponível neste ambiente de desenvolvimento' : false }, async () => {
    const folderPath = makeBotFolder();
    const botId = 'integration-linux-backend';
    insertBot(botId, folderPath);

    await startBot(botId);
    const entry = activeProcesses.get(botId);
    assert.equal(entry.sandbox.status().backend, 'linux');

    await new Promise((r) => setTimeout(r, 500));
    const logs = entry.sandbox.logs().map((l) => l.line).join('');
    assert.ok(logs.includes('BOT_INTEGRATION_OK'));

    stopBot(botId);
    const deadline = Date.now() + 5000;
    while (activeProcesses.has(botId) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(activeProcesses.has(botId), false);
});
