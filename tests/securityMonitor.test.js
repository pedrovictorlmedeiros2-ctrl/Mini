const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-securityMonitor.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, query } = require('../src/database/database');
initDatabase();

const config = require('../config');
config.security.kamikaze.correlationWindowMs = 5000;
config.security.kamikaze.highThresholdCount = 3;
config.security.groqMonitor.minConfidenceToForwardSignal = 0.6;
config.security.groqMonitor.degradedAfterConsecutiveFailures = 3;

const { reportSignal } = require('../src/managers/security/SecurityEngine');
const { _resetCursorForTests } = require('../src/managers/security/monitor/SignalCollector');
const { pseudonymFor } = require('../src/managers/security/monitor/redactPayload');
const {
    pollAndEnqueue,
    analyzeBotEvents,
    startSecurityMonitor,
    stopSecurityMonitor,
    getGroqMonitorHealth,
    _setAnalyzeThreatForTests,
    _resetForTests,
} = require('../src/managers/security/monitor/SecurityMonitor');
const { getQueueMetrics } = require('../src/managers/queueManager');
const { computeReadiness, STATUS } = require('../src/managers/serviceReadiness');

// ── Fixtures pro serviceReadiness (mesmo padrão de processManagerSandboxIntegration.test.js):
// aponta os diretórios exigidos pra um temp writable e desliga a exigência
// de isolamento Linux forte, pra computeReadiness() não ficar BLOCKED por
// motivos que não têm nada a ver com o que este arquivo testa.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'securityMonitor-readiness-'));
config.system.botsFolder = path.join(tmpRoot, 'bots');
config.system.backupsFolder = path.join(tmpRoot, 'backups');
config.system.quarantineFolder = path.join(tmpRoot, 'quarantine');
config.system.logsFolder = path.join(tmpRoot, 'logs');
process.env.REQUIRE_LINUX_SANDBOX = 'false';

let counter = 0;
function makeRealBot(label) {
    counter += 1;
    const botId = `smtest-${label}-${counter}`;
    const userId = `${botId}-owner`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    run(
        "INSERT INTO bots (id, code, name, creator_id, folder_path) VALUES (?, ?, ?, ?, ?)",
        [botId, botId, 'Bot Teste', userId, `/tmp/${botId}`]
    );
    return botId;
}

async function waitForQueueIdle(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const m = getQueueMetrics();
        if (m.queued === 0 && m.active === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('fila não ficou ociosa dentro do timeout do teste');
}

function fakeGroqResult(overrides = {}) {
    return {
        available: true,
        classification: 'suspicious',
        confidence: 0.9,
        categories: [],
        reasonCodes: [],
        recommendedAction: 'observe',
        needsHumanReview: false,
        summary: '',
        ...overrides,
    };
}

test.beforeEach(() => {
    _resetForTests();
});

test('analyzeBotEvents: classificação "suspicious" chega ao SecurityEngine mas nunca cria incidente sozinha', async () => {
    const botId = makeRealBot('suspicious-alone');
    _setAnalyzeThreatForTests(async () => fakeGroqResult({ classification: 'suspicious', confidence: 0.9 }));

    await analyzeBotEvents(botId, [
        { code: 'banned_module_blocked', source: 'test', category: 'sandbox_bypass', severity: 'SUSPICIOUS', occurrences: 1 },
    ]);

    const signalRows = query(
        "SELECT * FROM audit_log WHERE action = 'security_signal:groq_suggested_suspicious' AND details LIKE ?",
        [`%${botId}%`]
    );
    assert.equal(signalRows.length, 1);

    const incidents = query('SELECT * FROM incidents WHERE bot_id = ?', [botId]);
    assert.equal(incidents.length, 0);
});

test('GROQ SOZINHO NUNCA ATIVA KAMIKAZE via SecurityMonitor: 20 respostas "likely_malicious" de alta confiança seguidas nunca criam incidente', async () => {
    const botId = makeRealBot('groq-alone-critical');
    _setAnalyzeThreatForTests(async () => fakeGroqResult({ classification: 'likely_malicious', confidence: 0.99 }));

    for (let i = 0; i < 20; i++) {
        await analyzeBotEvents(botId, [
            { code: 'pids_ceiling', source: 'test', category: 'resource_abuse', severity: 'SUSPICIOUS', occurrences: 1 },
        ]);
    }

    const incidents = query('SELECT * FROM incidents WHERE bot_id = ?', [botId]);
    assert.equal(incidents.length, 0, 'sinais só do Groq, por mais que se repitam, nunca deveriam criar um incidente');
});

test('Groq indisponível/offline não afeta o Kamikaze determinístico: evidência dura continua ativando CRITICAL', async () => {
    const botId = makeRealBot('groq-offline-hard-evidence');
    _setAnalyzeThreatForTests(async () => ({
        available: false,
        unavailableReason: 'timeout simulado no teste',
        classification: 'unknown',
        confidence: 0,
        categories: [],
        reasonCodes: [],
        recommendedAction: 'observe',
        needsHumanReview: false,
        summary: '',
    }));

    for (let i = 0; i < 5; i++) {
        await analyzeBotEvents(botId, [
            { code: 'symlink_escape_blocked', source: 'test', category: 'sandbox_bypass', severity: 'SUSPICIOUS', occurrences: 1 },
        ]);
    }

    const { SEVERITY } = require('../src/managers/security/SecurityEngine');
    const result = reportSignal({ botId, source: 'test', code: 'platform_secret_path_blocked', details: {} });
    assert.equal(result.severity, SEVERITY.CRITICAL);
    assert.equal(result.triggered, true);
});

test('FILA ASSÍNCRONA / PROCESSO NÃO BLOQUEIA: pollAndEnqueue retorna quase na hora mesmo com uma análise Groq lenta em andamento', async () => {
    const botId = makeRealBot('slow-groq');
    _resetCursorForTests();
    reportSignal({ botId, source: 'test', code: 'banned_module_blocked', details: {} });

    const SLOW_MS = 300;
    _setAnalyzeThreatForTests(async () => {
        await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
        return fakeGroqResult({ classification: 'benign', confidence: 0.5 });
    });

    const start = Date.now();
    await pollAndEnqueue();
    const elapsed = Date.now() - start;

    assert.ok(elapsed < SLOW_MS, `pollAndEnqueue não deveria esperar a análise lenta do Groq (levou ${elapsed}ms, análise simulada leva ${SLOW_MS}ms)`);

    await waitForQueueIdle();
});

test('ISOLAMENTO: poll com dois bots enfileira uma análise por bot, cada uma só com os eventos daquele bot', async () => {
    const botA = makeRealBot('isolation-A');
    const botB = makeRealBot('isolation-B');
    _resetCursorForTests();

    reportSignal({ botId: botA, source: 'test', code: 'banned_module_blocked', details: {} });
    reportSignal({ botId: botB, source: 'test', code: 'symlink_escape_blocked', details: {} });

    const calls = [];
    _setAnalyzeThreatForTests(async (payload) => {
        calls.push(payload);
        return fakeGroqResult({ classification: 'benign', confidence: 0.5 });
    });

    await pollAndEnqueue();
    await waitForQueueIdle();

    assert.equal(calls.length, 2);
    const refs = calls.map((c) => c.ref).sort();
    assert.deepEqual(refs, [pseudonymFor(botA), pseudonymFor(botB)].sort());

    const callForA = calls.find((c) => c.ref === pseudonymFor(botA));
    const callForB = calls.find((c) => c.ref === pseudonymFor(botB));
    assert.equal(callForA.events.length, 1);
    assert.equal(callForA.events[0].code, 'banned_module_blocked');
    assert.equal(callForB.events.length, 1);
    assert.equal(callForB.events[0].code, 'symlink_escape_blocked');
});

test('SAÚDE OPERACIONAL: falhas consecutivas só contam quando o monitor está habilitado E com GROQ_API_KEY configurada', async () => {
    const botId = makeRealBot('health-tracking');
    const originalEnabled = config.security.groqMonitor.enabled;
    const originalKey = process.env.GROQ_API_KEY;

    try {
        // Caso A: desabilitado — nunca conta como falha operacional.
        config.security.groqMonitor.enabled = false;
        delete process.env.GROQ_API_KEY;
        _setAnalyzeThreatForTests(async () => ({ available: false, unavailableReason: 'desabilitado', classification: 'unknown', confidence: 0, categories: [], reasonCodes: [], recommendedAction: 'observe', needsHumanReview: false, summary: '' }));
        await analyzeBotEvents(botId, [{ code: 'x', source: 't', category: 'unknown', severity: 'SUSPICIOUS', occurrences: 1 }]);
        assert.equal(getGroqMonitorHealth().consecutiveUnavailable, 0);

        // Caso B: habilitado + chave presente — falhas agora contam.
        config.security.groqMonitor.enabled = true;
        process.env.GROQ_API_KEY = 'fake-nonsense-test-key-never-sent-over-network';
        for (let i = 0; i < 2; i++) {
            await analyzeBotEvents(botId, [{ code: 'x', source: 't', category: 'unknown', severity: 'SUSPICIOUS', occurrences: 1 }]);
        }
        assert.equal(getGroqMonitorHealth().consecutiveUnavailable, 2);

        // Sucesso reseta o contador e marca lastAvailableAt.
        _setAnalyzeThreatForTests(async () => fakeGroqResult({ classification: 'benign', confidence: 0.5 }));
        await analyzeBotEvents(botId, [{ code: 'x', source: 't', category: 'unknown', severity: 'SUSPICIOUS', occurrences: 1 }]);
        const health = getGroqMonitorHealth();
        assert.equal(health.consecutiveUnavailable, 0);
        assert.ok(health.lastAvailableAt);
    } finally {
        config.security.groqMonitor.enabled = originalEnabled;
        if (originalKey === undefined) delete process.env.GROQ_API_KEY;
        else process.env.GROQ_API_KEY = originalKey;
    }
});

test('serviceReadiness: indisponibilidade prolongada do Groq vira DEGRADED (nunca BLOCKED), só quando habilitado+configurado', async () => {
    const botId = makeRealBot('readiness-degraded');
    const originalEnabled = config.security.groqMonitor.enabled;
    const originalKey = process.env.GROQ_API_KEY;

    try {
        config.security.groqMonitor.enabled = true;
        process.env.GROQ_API_KEY = 'fake-nonsense-test-key-never-sent-over-network';
        _setAnalyzeThreatForTests(async () => ({ available: false, unavailableReason: 'falha simulada', classification: 'unknown', confidence: 0, categories: [], reasonCodes: [], recommendedAction: 'observe', needsHumanReview: false, summary: '' }));

        for (let i = 0; i < config.security.groqMonitor.degradedAfterConsecutiveFailures; i++) {
            await analyzeBotEvents(botId, [{ code: 'x', source: 't', category: 'unknown', severity: 'SUSPICIOUS', occurrences: 1 }]);
        }

        const stateWithFailures = await computeReadiness();
        assert.notEqual(stateWithFailures.status, STATUS.BLOCKED, 'Groq indisponível nunca deveria bloquear hospedagem');
        assert.ok(
            stateWithFailures.degradedReasons.some((r) => r.toLowerCase().includes('groq')),
            `esperava um motivo DEGRADED mencionando Groq, recebeu: ${JSON.stringify(stateWithFailures.degradedReasons)}`
        );

        // Desabilitar o monitor apaga o motivo, mesmo com o histórico de falhas ainda em memória.
        config.security.groqMonitor.enabled = false;
        const stateDisabled = await computeReadiness();
        assert.ok(
            !stateDisabled.degradedReasons.some((r) => r.toLowerCase().includes('groq')),
            'com o monitor desabilitado, indisponibilidade do Groq não deveria aparecer como degradação'
        );
    } finally {
        config.security.groqMonitor.enabled = originalEnabled;
        if (originalKey === undefined) delete process.env.GROQ_API_KEY;
        else process.env.GROQ_API_KEY = originalKey;
    }
});

test('startSecurityMonitor/stopSecurityMonitor: liga e desliga o timer sem lançar, idempotente', () => {
    assert.doesNotThrow(() => startSecurityMonitor());
    assert.doesNotThrow(() => startSecurityMonitor()); // segunda chamada não duplica o timer
    assert.doesNotThrow(() => stopSecurityMonitor());
    assert.doesNotThrow(() => stopSecurityMonitor()); // idempotente
});
