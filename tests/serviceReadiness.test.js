const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../config');
const { detectCapabilities } = require('../src/managers/sandbox/capabilityDetector');
const {
    STATUS,
    computeReadiness,
    getReadinessState,
    assertProvisioningAllowed,
    isProductionIsolationRequired,
} = require('../src/managers/serviceReadiness');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-readiness-test-'));

function pointAllDirsTo(root) {
    config.system.botsFolder = path.join(root, 'bots');
    config.system.backupsFolder = path.join(root, 'backups');
    config.system.quarantineFolder = path.join(root, 'quarantine');
    config.system.logsFolder = path.join(root, 'logs');
}

// Snapshot dos valores originais pra restaurar ao final (não vazar estado
// pra outros arquivos de teste, embora cada um rode em processo próprio).
const originalDirs = {
    botsFolder: config.system.botsFolder,
    backupsFolder: config.system.backupsFolder,
    quarantineFolder: config.system.quarantineFolder,
    logsFolder: config.system.logsFolder,
};
const originalEnv = {
    REQUIRE_LINUX_SANDBOX: process.env.REQUIRE_LINUX_SANDBOX,
    NODE_ENV: process.env.NODE_ENV,
    LOG_WEBHOOK_URL: process.env.LOG_WEBHOOK_URL,
    USE_CONTAINERS: process.env.USE_CONTAINERS,
};

function restoreEnv() {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

test('READY: diretórios graváveis, isolamento não exigido, webhook admin configurado', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'ready-case'));
    process.env.REQUIRE_LINUX_SANDBOX = 'false';
    delete process.env.NODE_ENV;
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/fake/fake';
    process.env.USE_CONTAINERS = 'false';

    const result = await computeReadiness();

    assert.equal(result.status, STATUS.READY, `esperava READY, motivos: ${JSON.stringify(result)}`);
    assert.equal(result.blockedReasons.length, 0);
    assert.equal(result.degradedReasons.length, 0);
    assert.doesNotThrow(() => assertProvisioningAllowed('teste'));

    restoreEnv();
});

test('DEGRADED: LOG_WEBHOOK_URL ausente não bloqueia hospedagem, só degrada observação administrativa', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'degraded-case'));
    process.env.REQUIRE_LINUX_SANDBOX = 'false';
    delete process.env.LOG_WEBHOOK_URL;
    process.env.USE_CONTAINERS = 'false';

    const result = await computeReadiness();

    assert.equal(result.status, STATUS.DEGRADED);
    assert.equal(result.blockedReasons.length, 0, 'DEGRADED não pode ter motivo de bloqueio');
    assert.ok(result.degradedReasons.some((r) => /LOG_WEBHOOK_URL/.test(r)));
    // DEGRADED ainda permite provisionar — só BLOCKED recusa.
    assert.doesNotThrow(() => assertProvisioningAllowed('teste'));

    restoreEnv();
});

test('BLOCKED: diretório essencial não gravável — bloqueia mesmo sem exigir isolamento Linux', async () => {
    // Aponta o diretório de quarentena pra dentro de um ARQUIVO (não uma
    // pasta) — mkdirSync vai falhar de verdade, de forma determinística,
    // independente das capacidades reais do host rodando o teste.
    const blockerFile = path.join(tmpRoot, 'this-is-a-file-not-a-dir');
    fs.writeFileSync(blockerFile, 'x');

    pointAllDirsTo(path.join(tmpRoot, 'blocked-case'));
    config.system.quarantineFolder = path.join(blockerFile, 'quarantine'); // impossível de criar

    process.env.REQUIRE_LINUX_SANDBOX = 'false';
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/fake/fake';

    const result = await computeReadiness();

    assert.equal(result.status, STATUS.BLOCKED);
    assert.ok(result.blockedReasons.some((r) => /quarentena/.test(r)));
    assert.throws(() => assertProvisioningAllowed('iniciar bot'), /BLOCKED/);

    restoreEnv();
});

test('BLOCKED: isolamento Linux forte exigido e indisponível — nunca cai pro backend reduzido silenciosamente', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'isolation-case'));
    process.env.REQUIRE_LINUX_SANDBOX = 'true';
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/fake/fake';

    const caps = detectCapabilities();
    const result = await computeReadiness();

    // Portável entre ambientes: não assume um resultado fixo de
    // detectCapabilities() (pode variar de host pra host — ver
    // SECURITY_LIMITATIONS.md), só que o gate reflete a mesma verdade que
    // o detector já reporta, de forma consistente.
    if (!caps.linuxSandboxReady) {
        assert.equal(result.status, STATUS.BLOCKED);
        assert.ok(result.blockedReasons.some((r) => /[Ii]solamento Linux/.test(r)));
        assert.throws(() => assertProvisioningAllowed('iniciar bot'));
    } else {
        assert.notEqual(result.status, STATUS.BLOCKED, 'com isolamento disponível, a exigência de produção não deveria bloquear');
    }

    restoreEnv();
});

test('REQUIRE_LINUX_SANDBOX=false sempre vence NODE_ENV=production (override explícito tem prioridade)', () => {
    process.env.NODE_ENV = 'production';
    process.env.REQUIRE_LINUX_SANDBOX = 'false';
    assert.equal(isProductionIsolationRequired(), false);

    process.env.REQUIRE_LINUX_SANDBOX = 'true';
    delete process.env.NODE_ENV;
    assert.equal(isProductionIsolationRequired(), true);

    restoreEnv();
});

test('getReadinessState() é uma leitura barata — não recomputa nada, só devolve o último resultado', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'cache-case'));
    process.env.REQUIRE_LINUX_SANDBOX = 'false';
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/fake/fake';
    process.env.USE_CONTAINERS = 'false';

    const computed = await computeReadiness();
    const cached = getReadinessState();

    assert.deepEqual(cached, computed);

    restoreEnv();
});

test('limpeza: restaura config.system original', () => {
    Object.assign(config.system, originalDirs);
    assert.equal(config.system.botsFolder, originalDirs.botsFolder);
});
