const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-signalCollector.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run } = require('../src/database/database');
initDatabase();

const config = require('../config');
config.security.kamikaze.correlationWindowMs = 5000;
config.security.kamikaze.highThresholdCount = 3;

const { reportSignal } = require('../src/managers/security/SecurityEngine');
const { pollNewSecurityEvents, _resetCursorForTests } = require('../src/managers/security/monitor/SignalCollector');

run(`INSERT INTO users (id, username, role) VALUES ('sctest-owner', 'tester', 'client')`);

let counter = 0;
function makeRealBot() {
    counter += 1;
    const botId = `sctest-bot-${counter}`;
    run(
        "INSERT INTO bots (id, code, name, creator_id, folder_path) VALUES (?, ?, ?, 'sctest-owner', ?)",
        [botId, botId, 'Bot Teste', `/tmp/${botId}`]
    );
    return botId;
}

test('sinal único gera um evento resumido com occurrences=1', () => {
    _resetCursorForTests();
    const botId = makeRealBot();
    reportSignal({ botId, source: 'test', code: 'banned_module_blocked', details: {} });

    const result = pollNewSecurityEvents();
    assert.ok(result.has(botId));
    const events = result.get(botId);
    assert.equal(events.length, 1);
    assert.equal(events[0].code, 'banned_module_blocked');
    assert.equal(events[0].occurrences, 1);
    assert.equal(events[0].category, 'sandbox_bypass');
});

test('repetição do mesmo código é agregada num único evento com occurrences correto', () => {
    _resetCursorForTests();
    const botId = makeRealBot();
    for (let i = 0; i < 4; i++) {
        reportSignal({ botId, source: 'test', code: 'pids_ceiling', details: {} });
    }

    const result = pollNewSecurityEvents();
    const events = result.get(botId);
    assert.equal(events.length, 1, 'códigos repetidos deveriam virar UM evento agregado, não vários');
    assert.equal(events[0].occurrences, 4);
    assert.equal(events[0].category, 'resource_abuse');
});

test('códigos diferentes do mesmo bot viram entradas separadas', () => {
    _resetCursorForTests();
    const botId = makeRealBot();
    reportSignal({ botId, source: 'test', code: 'banned_module_blocked', details: {} });
    reportSignal({ botId, source: 'test', code: 'symlink_escape_blocked', details: {} });

    const events = pollNewSecurityEvents().get(botId);
    const codes = events.map((e) => e.code).sort();
    assert.deepEqual(codes, ['banned_module_blocked', 'symlink_escape_blocked']);
});

test('ISOLAMENTO: sinais de bots diferentes nunca se misturam no mesmo grupo', () => {
    _resetCursorForTests();
    const botA = makeRealBot();
    const botB = makeRealBot();

    reportSignal({ botId: botA, source: 'test', code: 'banned_module_blocked', details: {} });
    reportSignal({ botId: botB, source: 'test', code: 'banned_module_blocked', details: {} });
    reportSignal({ botId: botA, source: 'test', code: 'symlink_escape_blocked', details: {} });

    const result = pollNewSecurityEvents();
    assert.equal(result.size, 2);
    assert.equal(result.get(botA).length, 2);
    assert.equal(result.get(botB).length, 1);
    assert.ok(!result.get(botB).some((e) => e.code === 'symlink_escape_blocked'), 'evento do bot A nunca deveria aparecer no grupo do bot B');
});

test('CURSOR: poll subsequente sem eventos novos retorna vazio; eventos antigos nunca são reprocessados', () => {
    _resetCursorForTests();
    const botId = makeRealBot();
    reportSignal({ botId, source: 'test', code: 'banned_module_blocked', details: {} });

    const first = pollNewSecurityEvents();
    assert.equal(first.get(botId).length, 1);

    const second = pollNewSecurityEvents();
    assert.equal(second.size, 0, 'sem eventos novos desde o último poll, deveria vir vazio');

    reportSignal({ botId, source: 'test', code: 'symlink_escape_blocked', details: {} });
    const third = pollNewSecurityEvents();
    assert.equal(third.get(botId).length, 1, 'só o evento NOVO deveria aparecer, não repetir o antigo');
    assert.equal(third.get(botId)[0].code, 'symlink_escape_blocked');
});

test('matchedPath (quando presente no sinal original) é propagado pro evento resumido, sem redação ainda (responsabilidade de outra camada)', () => {
    _resetCursorForTests();
    const botId = makeRealBot();
    reportSignal({ botId, source: 'security_wrapper', code: 'platform_secret_path_blocked', details: { matchedPath: '/home/user/Mini/.env' } });

    const events = pollNewSecurityEvents().get(botId);
    assert.equal(events[0].matchedPath, '/home/user/Mini/.env');
});

test('linha de audit_log malformada (JSON inválido) nunca derruba o coletor — é só ignorada', () => {
    _resetCursorForTests();
    const botId = makeRealBot();
    reportSignal({ botId, source: 'test', code: 'banned_module_blocked', details: {} });
    // Insere uma linha "podre" manualmente, simulando corrupção/bug de outro lugar.
    run("INSERT INTO audit_log (user_id, action, details, severity) VALUES (NULL, 'security_signal:algo_quebrado', 'isto nao e json', 'info')");
    reportSignal({ botId, source: 'test', code: 'symlink_escape_blocked', details: {} });

    assert.doesNotThrow(() => pollNewSecurityEvents());
});

test('ROBUSTEZ: linha malformada não impede o processamento das linhas boas ao redor dela', () => {
    _resetCursorForTests();
    const botId = makeRealBot();
    run("INSERT INTO audit_log (user_id, action, details, severity) VALUES (NULL, 'security_signal:algo_quebrado', 'isto nao e json', 'info')");
    reportSignal({ botId, source: 'test', code: 'banned_module_blocked', details: {} });

    const result = pollNewSecurityEvents();
    assert.ok(result.has(botId));
    assert.equal(result.get(botId).length, 1);
    assert.equal(result.get(botId)[0].code, 'banned_module_blocked');
});
