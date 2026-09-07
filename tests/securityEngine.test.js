const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Precisa vir ANTES de qualquer require que transitivamente carregue
// config.js (que lê process.env.ENCRYPTION_KEY uma única vez, no momento
// em que o módulo é carregado pela primeira vez) — mesmo padrão já usado
// em tests/crypto.test.js.
process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-securityEngine.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase } = require('../src/database/database');
initDatabase();

const config = require('../config');
// Janela curta e teto baixo pra não depender de esperar minutos reais nos testes.
config.security.kamikaze.correlationWindowMs = 5000;
config.security.kamikaze.highThresholdCount = 3;

const { reportSignal, SEVERITY } = require('../src/managers/security/SecurityEngine');

function uniqueBotId(label) {
    return `sectest-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

test('sinal único e isolado é classificado como SUSPICIOUS (nunca restringe nada)', () => {
    const botId = uniqueBotId('suspicious');
    const result = reportSignal({ botId, source: 'test', code: 'banned_module_blocked', details: {} });
    assert.equal(result.severity, SEVERITY.SUSPICIOUS);
    assert.equal(result.triggered, false);
});

test('repetição do MESMO código dentro da janela escala pra HIGH, mas nunca além sozinha', () => {
    const botId = uniqueBotId('high');
    let last;
    for (let i = 0; i < 3; i++) {
        last = reportSignal({ botId, source: 'test', code: 'banned_module_blocked', details: {} });
    }
    assert.equal(last.severity, SEVERITY.HIGH);
    assert.equal(last.triggered, false);

    // Mais repetições do MESMO código continuam HIGH — uma categoria
    // sozinha nunca escala pra CRITICAL, não importa quantas vezes repita
    // (requisito explícito: não decidir CRITICAL por uma única heurística).
    for (let i = 0; i < 5; i++) {
        last = reportSignal({ botId, source: 'test', code: 'banned_module_blocked', details: {} });
    }
    assert.equal(last.severity, SEVERITY.HIGH);
    assert.equal(last.triggered, false);
});

test('evidência dura (platform_secret_path_blocked) é CRITICAL num único evento, sem precisar de repetição', () => {
    const botId = uniqueBotId('hard-evidence');
    const result = reportSignal({ botId, source: 'test', code: 'platform_secret_path_blocked', details: {} });
    assert.equal(result.severity, SEVERITY.CRITICAL);
    assert.equal(result.triggered, true);
});

test('correlação de DUAS categorias independentes em HIGH escala pra CRITICAL', () => {
    const botId = uniqueBotId('correlated');

    // Categoria 'sandbox_bypass': symlink_escape_blocked x3 -> HIGH (sozinha, ainda não CRITICAL)
    let lastSandbox;
    for (let i = 0; i < 3; i++) {
        lastSandbox = reportSignal({ botId, source: 'test', code: 'symlink_escape_blocked', details: {} });
    }
    assert.equal(lastSandbox.severity, SEVERITY.HIGH, 'uma categoria sozinha em HIGH não deveria virar CRITICAL ainda');

    // Categoria 'resource_abuse': pids_ceiling x3 -> agora DUAS categorias em HIGH -> CRITICAL
    let lastResource;
    for (let i = 0; i < 3; i++) {
        lastResource = reportSignal({ botId, source: 'test', code: 'pids_ceiling', details: {} });
    }
    assert.equal(lastResource.severity, SEVERITY.CRITICAL);
    assert.equal(lastResource.triggered, true);
});

test('código fora do mapa de categorias conhecidas nunca participa de correlação, mesmo repetido muitas vezes', () => {
    const botId = uniqueBotId('unknown-category');
    let last;
    for (let i = 0; i < 10; i++) {
        last = reportSignal({ botId, source: 'test', code: 'codigo_nao_mapeado_de_proposito', details: {} });
    }
    assert.notEqual(last.severity, SEVERITY.CRITICAL, 'categoria unknown nunca deveria escalar sozinha a CRITICAL');
    assert.equal(last.triggered, false);
});

test('duas categorias diferentes, mas nenhuma delas batendo o teto de repetição, não escalam a CRITICAL', () => {
    const botId = uniqueBotId('not-enough-repeats');
    let last;
    // Só 2 ocorrências de cada (teto configurado é 3) — nenhuma categoria chega a HIGH.
    for (let i = 0; i < 2; i++) {
        reportSignal({ botId, source: 'test', code: 'symlink_escape_blocked', details: {} });
        last = reportSignal({ botId, source: 'test', code: 'pids_ceiling', details: {} });
    }
    assert.notEqual(last.severity, SEVERITY.CRITICAL);
});

test('Kamikaze desabilitado (config.security.kamikaze.enabled=false) nunca aciona, mesmo com evidência dura', () => {
    const original = config.security.kamikaze.enabled;
    config.security.kamikaze.enabled = false;
    try {
        const botId = uniqueBotId('disabled');
        const result = reportSignal({ botId, source: 'test', code: 'platform_secret_path_blocked', details: {} });
        assert.equal(result.triggered, false);
    } finally {
        config.security.kamikaze.enabled = original;
    }
});

test('reportSignal exige botId e code', () => {
    assert.throws(() => reportSignal({ source: 'test', code: 'x' }));
    assert.throws(() => reportSignal({ botId: 'x', source: 'test' }));
});
