const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-threatDecisionPolicy.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, query, get } = require('../src/database/database');
initDatabase();

const config = require('../config');
config.security.kamikaze.correlationWindowMs = 5000;
config.security.kamikaze.highThresholdCount = 3;
config.security.groqMonitor.minConfidenceToForwardSignal = 0.6;

const { reportSignal, SEVERITY } = require('../src/managers/security/SecurityEngine');
const { applyThreatDecision, CODE_FOR_CLASSIFICATION } = require('../src/managers/security/monitor/ThreatDecisionPolicy');

let counter = 0;
function makeRealBot(label) {
    counter += 1;
    const botId = `tdptest-${label}-${counter}`;
    const userId = `${botId}-owner`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    run(
        "INSERT INTO bots (id, code, name, creator_id, folder_path) VALUES (?, ?, ?, ?, ?)",
        [botId, botId, 'Bot Teste', userId, `/tmp/${botId}`]
    );
    return botId;
}

function groqResult(overrides = {}) {
    return {
        available: true,
        classification: 'suspicious',
        confidence: 0.9,
        categories: ['sandbox_bypass'],
        reasonCodes: ['repeated_violation'],
        recommendedAction: 'increase_monitoring',
        needsHumanReview: false,
        summary: 'teste',
        ...overrides,
    };
}

function securitySignalRows(botId, code) {
    return query(
        "SELECT * FROM audit_log WHERE action = ? AND details LIKE ?",
        [`security_signal:${code}`, `%${botId}%`]
    );
}

test('classificação "suspicious" com confiança acima do teto: encaminha pro SecurityEngine com o code correto', () => {
    const botId = makeRealBot('forward-suspicious');
    const { forwarded, forwardedCode } = applyThreatDecision(botId, groqResult({ classification: 'suspicious', confidence: 0.9 }));

    assert.equal(forwarded, true);
    assert.equal(forwardedCode, 'groq_suggested_suspicious');
    assert.equal(securitySignalRows(botId, 'groq_suggested_suspicious').length, 1);
});

test('classificação "likely_malicious" com confiança acima do teto: encaminha com o code de HIGH', () => {
    const botId = makeRealBot('forward-malicious');
    const { forwarded, forwardedCode } = applyThreatDecision(botId, groqResult({ classification: 'likely_malicious', confidence: 0.95 }));

    assert.equal(forwarded, true);
    assert.equal(forwardedCode, CODE_FOR_CLASSIFICATION.likely_malicious);
});

test('confiança ABAIXO do teto mínimo: nunca encaminha, mesmo com classificação suspeita', () => {
    const botId = makeRealBot('low-confidence');
    const { forwarded } = applyThreatDecision(botId, groqResult({ classification: 'likely_malicious', confidence: 0.1 }));

    assert.equal(forwarded, false);
    assert.equal(securitySignalRows(botId, 'groq_suggested_high').length, 0);
    assert.equal(securitySignalRows(botId, 'groq_suggested_suspicious').length, 0);
});

test('classificação "benign"/"unknown": nunca encaminha nada, mesmo com confiança alta', () => {
    const botId = makeRealBot('benign');
    applyThreatDecision(botId, groqResult({ classification: 'benign', confidence: 0.99 }));
    applyThreatDecision(botId, groqResult({ classification: 'unknown', confidence: 0.99 }));

    assert.equal(securitySignalRows(botId, 'groq_suggested_high').length, 0);
    assert.equal(securitySignalRows(botId, 'groq_suggested_suspicious').length, 0);
});

test('Groq indisponível (available:false): nunca encaminha nada, só registra a decisão', () => {
    const botId = makeRealBot('unavailable');
    const { forwarded } = applyThreatDecision(botId, {
        available: false,
        unavailableReason: 'timeout',
        classification: 'unknown',
        confidence: 0,
        categories: [],
        reasonCodes: [],
        recommendedAction: 'observe',
        needsHumanReview: false,
        summary: '',
    });

    assert.equal(forwarded, false);
    const decisionRows = query("SELECT * FROM audit_log WHERE action = 'groq_monitor:decision' AND details LIKE ?", [`%${botId}%`]);
    assert.equal(decisionRows.length, 1);
});

test('needsHumanReview=true nunca lança (mesmo sem LOG_WEBHOOK_URL configurado) e fica registrado na auditoria', () => {
    const botId = makeRealBot('human-review');
    assert.doesNotThrow(() => applyThreatDecision(botId, groqResult({ needsHumanReview: true })));

    const decisionRows = query("SELECT * FROM audit_log WHERE action = 'groq_monitor:decision' AND details LIKE ?", [`%${botId}%`]);
    const details = JSON.parse(decisionRows[decisionRows.length - 1].details);
    assert.equal(details.needsHumanReview, true);
});

test('GROQ SOZINHO NUNCA ATIVA KAMIKAZE: repetir "likely_malicious" com confiança altíssima várias vezes NUNCA cria um incidente', () => {
    const botId = makeRealBot('groq-alone-never-critical');

    for (let i = 0; i < 20; i++) {
        applyThreatDecision(botId, groqResult({ classification: 'likely_malicious', confidence: 0.99 }));
    }

    // Deveria ter escalado a HIGH (repetição do mesmo code), mas NUNCA a
    // CRITICAL — o code do Groq fica na categoria 'unknown', excluída da
    // correlação que decide CRITICAL no SecurityEngine (código não
    // modificado nesta fase).
    const incidents = query('SELECT * FROM incidents WHERE bot_id = ?', [botId]);
    assert.equal(incidents.length, 0, 'nenhum incidente deveria ter sido criado só por sinais do Groq, por mais que se repitam');
});

test('UM SINAL SUSPICIOUS NÃO ATIVA KAMIKAZE: uma única sugestão do Groq nunca vira incidente', () => {
    const botId = makeRealBot('single-suspicious');
    applyThreatDecision(botId, groqResult({ classification: 'suspicious', confidence: 0.9 }));

    const incidents = query('SELECT * FROM incidents WHERE bot_id = ?', [botId]);
    assert.equal(incidents.length, 0);
});

test('EVIDÊNCIA DURA CONTINUA ATIVANDO CRITICAL: sinal determinístico do SecurityEngine funciona igual, mesmo com ruído do Groq no mesmo bot', () => {
    const botId = makeRealBot('hard-evidence-still-works');

    // Bombardeia com sugestões do Groq primeiro (ruído).
    for (let i = 0; i < 10; i++) {
        applyThreatDecision(botId, groqResult({ classification: 'likely_malicious', confidence: 0.99 }));
    }

    // Sinal determinístico de sempre — não passa pelo Groq de jeito nenhum.
    const result = reportSignal({ botId, source: 'test', code: 'platform_secret_path_blocked', details: {} });
    assert.equal(result.severity, SEVERITY.CRITICAL);
    assert.equal(result.triggered, true);
});

test('DOIS SINAIS DETERMINÍSTICOS VÁLIDOS CONTINUAM ATIVANDO CRITICAL, mesmo com o Groq ativo no mesmo bot', () => {
    const botId = makeRealBot('two-deterministic-still-critical');

    // Ruído do Groq no mesmo bot, simultâneo.
    for (let i = 0; i < 5; i++) {
        applyThreatDecision(botId, groqResult({ classification: 'likely_malicious', confidence: 0.99 }));
    }

    // Duas categorias determinísticas independentes em HIGH -> CRITICAL
    // (mesma regra de sempre do SecurityEngine, não relacionada ao Groq).
    for (let i = 0; i < 3; i++) reportSignal({ botId, source: 'test', code: 'symlink_escape_blocked', details: {} });
    let last;
    for (let i = 0; i < 3; i++) last = reportSignal({ botId, source: 'test', code: 'pids_ceiling', details: {} });

    assert.equal(last.severity, SEVERITY.CRITICAL);
});

test('ISOLAMENTO: encaminhar um sinal do Groq pro bot A nunca cria nada em nome do bot B', () => {
    const botA = makeRealBot('isolation-A');
    const botB = makeRealBot('isolation-B');

    applyThreatDecision(botA, groqResult({ classification: 'likely_malicious', confidence: 0.95 }));

    assert.equal(securitySignalRows(botB, 'groq_suggested_high').length, 0);
    assert.equal(query('SELECT * FROM incidents WHERE bot_id = ?', [botB]).length, 0);
});
