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
const alertManager = require('../src/managers/alertManager');
const clientRef = require('../src/utils/clientRef');

// FASE 9: computeReadiness() agora chama alertManager.sendAlert()/clientRef.tryDM()
// em toda mudança de estado (ver maybeAlertReadinessChange() dentro de
// serviceReadiness.js). Vários testes abaixo já manipulavam LOG_WEBHOOK_URL
// com uma URL real do domínio discord.com (só com IDs falsos) pra simular
// "webhook configurado" — sem este stub, isso dispararia uma chamada de
// rede REAL a cada transição de estado durante os testes. Stub instalado
// pra todo o arquivo (nunca restaurado no meio) — os testes existentes
// nunca dependiam do comportamento real de sendAlert()/tryDM(), então
// interceptar não muda nenhuma asserção já existente, só evita o efeito
// colateral de rede. `alertCalls`/`dmCalls` ficam disponíveis pros novos
// testes desta fase que PRECISAM inspecionar se o alerta disparou.
let alertCalls = [];
let dmCalls = [];
alertManager.sendAlert = async (title, message, type) => { alertCalls.push({ title, message, type }); };
clientRef.tryDM = async (userId, content) => { dmCalls.push({ userId, content }); return true; };
function resetAlertSpies() {
    alertCalls = [];
    dmCalls = [];
}

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

test('FAIL-CLOSED: estado inicial (antes de qualquer computeReadiness()) é BLOCKED, nunca READY por omissão', () => {
    // Precisa ser o PRIMEIRO teste do arquivo — getReadinessState() antes de
    // qualquer chamada a computeReadiness() deve refletir o default seguro
    // do módulo, não um valor otimista.
    const state = getReadinessState();
    assert.equal(state.status, STATUS.BLOCKED);
    assert.ok(state.blockedReasons.length > 0);
    assert.throws(() => assertProvisioningAllowed('teste'));
});

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

// ═══════════════════════════════════════════════════════════════════════
// FASE 9 (hardening): alertas proativos de mudança de estado
// ═══════════════════════════════════════════════════════════════════════

test('ALERTA: READY -> DEGRADED dispara alerta (webhook + DM)', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'alert-ready-degraded'));
    process.env.REQUIRE_LINUX_SANDBOX = 'false';
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/fake/fake';
    await computeReadiness();
    assert.equal(getReadinessState().status, STATUS.READY, 'sanity: precisa começar READY pro teste fazer sentido');
    resetAlertSpies();

    delete process.env.LOG_WEBHOOK_URL; // agora falta o webhook -> DEGRADED
    await computeReadiness();
    assert.equal(getReadinessState().status, STATUS.DEGRADED);
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0].title, /READY.*DEGRADED/);
    assert.equal(dmCalls.length, config.bot.ownerId ? 1 : 0, 'DM só é tentada se houver ownerId configurado');

    restoreEnv();
});

test('ALERTA: DEGRADED -> BLOCKED dispara alerta', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'alert-degraded-blocked'));
    delete process.env.LOG_WEBHOOK_URL;
    await computeReadiness();
    assert.equal(getReadinessState().status, STATUS.DEGRADED, 'sanity');
    resetAlertSpies();

    // Força BLOCKED de forma portável entre ambientes (não depende de
    // permissão de filesystem — rodando como root, "diretório inacessível"
    // por permissão não é garantido; REQUIRE_LINUX_SANDBOX=true já é o
    // método usado nas Fases 7/8 pra forçar BLOCKED de forma confiável).
    process.env.REQUIRE_LINUX_SANDBOX = 'true';
    await computeReadiness();
    assert.equal(getReadinessState().status, STATUS.BLOCKED, 'sanity: precisa realmente ter ficado BLOCKED pro resto do teste fazer sentido');
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0].title, /DEGRADED.*BLOCKED/);

    restoreEnv();
});

test('ALERTA: BLOCKED -> READY (recuperação total) dispara alerta', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'alert-blocked-ready-setup'));
    process.env.REQUIRE_LINUX_SANDBOX = 'true';
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/fake/fake';
    await computeReadiness();
    assert.equal(getReadinessState().status, STATUS.BLOCKED, 'sanity');
    resetAlertSpies();

    process.env.REQUIRE_LINUX_SANDBOX = 'false';
    pointAllDirsTo(path.join(tmpRoot, 'alert-blocked-ready'));
    await computeReadiness();
    assert.equal(getReadinessState().status, STATUS.READY);
    assert.equal(alertCalls.length, 1);
    assert.match(alertCalls[0].title, /BLOCKED.*READY/);

    restoreEnv();
});

test('ALERTA: DEGRADED -> READY (recuperação parcial) também dispara alerta', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'alert-degraded-ready'));
    delete process.env.LOG_WEBHOOK_URL;
    await computeReadiness();
    assert.equal(getReadinessState().status, STATUS.DEGRADED, 'sanity');
    resetAlertSpies();

    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/fake/fake';
    await computeReadiness();
    assert.equal(getReadinessState().status, STATUS.READY);
    assert.equal(alertCalls.length, 1);

    restoreEnv();
});

test('ALERTA: sem mudança de estado, NUNCA dispara alerta de novo (evita spam a cada recheck periódico)', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'alert-no-spam'));
    delete process.env.LOG_WEBHOOK_URL;
    await computeReadiness();
    assert.equal(getReadinessState().status, STATUS.DEGRADED, 'sanity');
    resetAlertSpies();

    await computeReadiness(); // mesmo estado de novo
    await computeReadiness(); // e de novo
    await computeReadiness();
    assert.equal(getReadinessState().status, STATUS.DEGRADED);
    assert.equal(alertCalls.length, 0, 'estado repetido nunca deveria gerar alerta novo');

    restoreEnv();
});

test('ALERTA: falha no envio do webhook nunca impede a tentativa de DM', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'alert-webhook-fails-1'));
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/fake/fake';
    await computeReadiness();
    resetAlertSpies();

    const originalSendAlert = alertManager.sendAlert;
    alertManager.sendAlert = async () => { throw new Error('webhook fora do ar (simulado)'); };
    try {
        pointAllDirsTo(path.join(tmpRoot, 'alert-webhook-fails-2'));
        delete process.env.LOG_WEBHOOK_URL;
        await assert.doesNotReject(() => computeReadiness(), 'computeReadiness() nunca pode lançar por causa de uma falha no alerta de webhook');
        await new Promise((resolve) => setImmediate(resolve)); // deixa o .catch() fire-and-forget assentar
        assert.equal(dmCalls.length, config.bot.ownerId ? 1 : 0, 'DM continua sendo tentada mesmo com o webhook falhando');
    } finally {
        alertManager.sendAlert = originalSendAlert;
        restoreEnv();
    }
});

test('ALERTA: falha na DM nunca quebra computeReadiness()', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'alert-dm-fails-1'));
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/fake/fake';
    await computeReadiness();
    resetAlertSpies();

    const originalTryDM = clientRef.tryDM;
    const originalOwnerId = config.bot.ownerId;
    config.bot.ownerId = 'owner-fake-p9';
    clientRef.tryDM = async () => { throw new Error('DM fechada (simulado)'); };
    try {
        pointAllDirsTo(path.join(tmpRoot, 'alert-dm-fails-2'));
        delete process.env.LOG_WEBHOOK_URL;
        await assert.doesNotReject(() => computeReadiness(), 'computeReadiness() nunca pode lançar por causa de uma falha na DM de alerta');
        assert.equal(getReadinessState().status, STATUS.DEGRADED, 'o estado real continua sendo computado normalmente');
    } finally {
        clientRef.tryDM = originalTryDM;
        config.bot.ownerId = originalOwnerId;
        restoreEnv();
    }
});

test('ALERTA: OWNER_ID ausente nunca causa crash — só não tenta DM', async () => {
    pointAllDirsTo(path.join(tmpRoot, 'alert-no-owner-1'));
    process.env.LOG_WEBHOOK_URL = 'https://discord.com/api/webhooks/fake/fake';
    await computeReadiness();
    resetAlertSpies();

    const originalOwnerId = config.bot.ownerId;
    config.bot.ownerId = undefined;
    try {
        pointAllDirsTo(path.join(tmpRoot, 'alert-no-owner-2'));
        delete process.env.LOG_WEBHOOK_URL;
        await assert.doesNotReject(() => computeReadiness());
        assert.equal(dmCalls.length, 0, 'sem ownerId configurado, nunca tenta DM');
        assert.equal(alertCalls.length, 1, 'o webhook continua sendo tentado independente do owner');
    } finally {
        config.bot.ownerId = originalOwnerId;
        restoreEnv();
    }
});

test('ALERTA: primeiro computeReadiness() da vida do processo resultando em READY NUNCA alerta (unitário, via _maybeAlertReadinessChange)', () => {
    const { _maybeAlertReadinessChange } = require('../src/managers/serviceReadiness');
    resetAlertSpies();
    const neverChecked = { status: STATUS.BLOCKED, blockedReasons: ['placeholder'], degradedReasons: [], checkedAt: null };
    const firstReady = { status: STATUS.READY, blockedReasons: [], degradedReasons: [], checkedAt: new Date().toISOString() };
    _maybeAlertReadinessChange(neverChecked, firstReady);
    assert.equal(alertCalls.length, 0, 'primeiro check bem-sucedido não é notícia');
    assert.equal(dmCalls.length, 0);
});

test('ALERTA: primeiro computeReadiness() da vida do processo resultando em DEGRADED/BLOCKED DISPARA alerta (unitário)', () => {
    const { _maybeAlertReadinessChange } = require('../src/managers/serviceReadiness');
    resetAlertSpies();
    const neverChecked = { status: STATUS.BLOCKED, blockedReasons: ['placeholder'], degradedReasons: [], checkedAt: null };
    const firstBlocked = { status: STATUS.BLOCKED, blockedReasons: ['disco cheio'], degradedReasons: [], checkedAt: new Date().toISOString() };
    _maybeAlertReadinessChange(neverChecked, firstBlocked);
    assert.equal(alertCalls.length, 1, 'primeiro check já revelando um problema real precisa alertar');
});

test('limpeza: restaura config.system original', () => {
    Object.assign(config.system, originalDirs);
    assert.equal(config.system.botsFolder, originalDirs.botsFolder);
});
