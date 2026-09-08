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

const { run, query, get } = require('../src/database/database');
const { reportSignal, SEVERITY } = require('../src/managers/security/SecurityEngine');

function uniqueBotId(label) {
    return `sectest-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeRealBot(label) {
    const botId = uniqueBotId(label);
    const userId = `${botId}-owner`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    const folderPath = path.join(require('os').tmpdir(), 'atlantic-sectest-bots', botId);
    fs.mkdirSync(folderPath, { recursive: true });
    run(
        "INSERT INTO bots (id, code, name, creator_id, folder_path) VALUES (?, ?, ?, ?, ?)",
        [botId, botId, 'Bot Teste', userId, folderPath]
    );
    return botId;
}

// reportSignal() dispara handleCriticalIncident() de forma assíncrona,
// fire-and-forget (ver SecurityEngine.js) — poll com teto, em vez de um
// setTimeout fixo (mais rápido quando já resolveu, sem depender de adivinhar
// um tempo de espera exato).
async function waitForIncident(botId, { timeoutMs = 2000, intervalMs = 25 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const incident = get('SELECT * FROM incidents WHERE bot_id = ? ORDER BY id DESC LIMIT 1', [botId]);
        if (incident && ['resolved', 'resolved_partial', 'failed_safe'].includes(incident.status)) {
            return incident;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return get('SELECT * FROM incidents WHERE bot_id = ? ORDER BY id DESC LIMIT 1', [botId]);
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

test('INTEGRAÇÃO com bot real: reportSignal() com evidência dura persiste um incidente de verdade em `incidents` (não só a classificação)', async () => {
    const botId = makeRealBot('real-incident');

    const result = reportSignal({ botId, source: 'test', code: 'platform_secret_path_blocked', details: {} });
    assert.equal(result.triggered, true);

    const incident = await waitForIncident(botId);
    assert.ok(incident, 'deveria existir uma linha em `incidents` pro bot real — o fluxo precisa ir além da classificação');
    assert.equal(incident.bot_id, botId);
    assert.equal(incident.severity, 'CRITICAL');
    assert.ok(['resolved', 'resolved_partial', 'failed_safe'].includes(incident.status), `status inesperado: ${incident.status}`);

    const auditRows = query("SELECT * FROM audit_log WHERE details LIKE ?", [`%${incident.id}%`]);
    assert.ok(auditRows.length > 0, 'o incidente deveria ter deixado rastro no audit_log');
});

test('CORREÇÃO DE SEGURANÇA (achado em validação): evidência dura pra um botId inexistente NUNCA lança "FOREIGN KEY constraint failed" nem trava o lock pra sempre', async () => {
    // Regressão do bug real: `incidents.bot_id` tem FK pra bots(id).
    // handleCriticalIncident() criava a linha do incidente ANTES de checar
    // se o bot existia, e fazia isso FORA do try/finally — a violação de FK
    // propagava pra fora da função, e activeIncidents.delete(botId) (no
    // finally) NUNCA rodava. Resultado: o lock em memória ficava vazado
    // pra sempre pra aquele botId — mesmo que um bot de verdade fosse
    // criado depois com o mesmo id, um novo sinal CRITICAL seria
    // silenciosamente coalescido, achando que já havia uma resposta em
    // andamento que na verdade nunca existiu.
    const ghostBotId = uniqueBotId('ghost-does-not-exist');

    const result = reportSignal({ botId: ghostBotId, source: 'test', code: 'platform_secret_path_blocked', details: {} });
    assert.equal(result.severity, SEVERITY.CRITICAL, 'a classificação em si não muda — o bug estava no que acontecia DEPOIS dela');

    // Dá tempo pro disparo assíncrono terminar (sem lançar, sem crashar o processo).
    await new Promise((r) => setTimeout(r, 300));

    const incidentsForGhost = query('SELECT * FROM incidents WHERE bot_id = ?', [ghostBotId]);
    assert.equal(incidentsForGhost.length, 0, 'nenhuma linha de incidente pode existir pra um bot que não existe (violaria a FK)');

    const auditRows = query("SELECT * FROM audit_log WHERE details LIKE ?", [`%${ghostBotId}%`]);
    assert.ok(auditRows.length > 0, 'mesmo sem poder criar o incidente, o evento precisa ficar auditável — nunca falhar em silêncio total');
    assert.ok(auditRows.some((r) => r.action === 'kamikaze:failed_safe'), 'deveria ter sido registrado explicitamente como failed_safe');

    // Prova de que o lock NÃO ficou vazado: cria o bot de verdade com o
    // MESMO id usado acima, dispara CRITICAL de novo, e confirma que desta
    // vez o incidente É processado (não coalescido/ignorado por um lock
    // fantasma da tentativa anterior).
    const userId = `${ghostBotId}-owner`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    const folderPath = path.join(require('os').tmpdir(), 'atlantic-sectest-bots', ghostBotId);
    fs.mkdirSync(folderPath, { recursive: true });
    run(
        "INSERT INTO bots (id, code, name, creator_id, folder_path) VALUES (?, ?, ?, ?, ?)",
        [ghostBotId, ghostBotId, 'Bot Ressuscitado', userId, folderPath]
    );

    reportSignal({ botId: ghostBotId, source: 'test', code: 'platform_secret_path_blocked', details: {} });
    const incidentAfterRealBotExists = await waitForIncident(ghostBotId);
    assert.ok(incidentAfterRealBotExists, 'depois que o bot passa a existir de verdade, um novo sinal CRITICAL precisa ser processado — prova que o lock anterior não ficou vazado');
});

test('ROBUSTEZ: botId com formato "malicioso" (SQL-like, path traversal, muito longo) nunca lança e nunca engana o banco — tratado como bot inexistente', async () => {
    const maliciousIds = [
        "'; DROP TABLE bots; --",
        '../../../../etc/passwd',
        'a'.repeat(5000),
        '',
    ];

    for (const botId of maliciousIds) {
        if (botId === '') {
            // botId vazio é tratado como "ausente" pela validação de entrada.
            assert.throws(() => reportSignal({ botId, source: 'test', code: 'platform_secret_path_blocked', details: {} }));
            continue;
        }
        assert.doesNotThrow(() => reportSignal({ botId, source: 'test', code: 'platform_secret_path_blocked', details: {} }));
    }

    // Prova de que nada disso corrompeu ou alterou a tabela bots de verdade
    // (parametrização do driver SQL faz o trabalho — mas confirmamos aqui).
    const botsCountRow = get('SELECT COUNT(*) as total FROM bots');
    await new Promise((r) => setTimeout(r, 300));
    const botsCountAfter = get('SELECT COUNT(*) as total FROM bots');
    assert.equal(botsCountAfter.total, botsCountRow.total, 'a tabela bots não deveria ter sido alterada por nenhum desses botIds');
});

test('ROBUSTEZ: payload com referência circular (JSON.stringify falharia) é capturado e registrado, nunca propaga um erro não tratado', async () => {
    const botId = makeRealBot('circular-payload');

    const circular = { a: 1 };
    circular.self = circular; // JSON.stringify(circular) lança TypeError

    assert.doesNotThrow(() => {
        reportSignal({ botId, source: 'test', code: 'platform_secret_path_blocked', details: circular });
    });

    await new Promise((r) => setTimeout(r, 300));

    // Não crashou o processo (o teste chegou até aqui) — e o evento ainda
    // deveria estar auditável, mesmo que o incidente em si não tenha sido
    // persistido por causa do JSON inválido.
    const auditRows = query("SELECT * FROM audit_log WHERE details LIKE ?", [`%${botId}%`]);
    assert.ok(auditRows.length > 0, 'mesmo com payload circular, deveria sobrar um rastro auditável');
});
