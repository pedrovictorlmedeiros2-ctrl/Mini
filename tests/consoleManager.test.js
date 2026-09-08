const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-console.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { addLog, getRecentLogs } = require('../src/managers/consoleManager');

test('addLog atualiza o buffer em memória e é lido por getRecentLogs', () => {
    addLog('bot-console-test-1', 'primeira linha', 'stdout');
    const logs = getRecentLogs('bot-console-test-1');
    assert.ok(logs.includes('primeira linha'));
});

test('ROTAÇÃO SEGURA: arquivo de log que passa do teto (5MB) é rotacionado pra .old antes da próxima escrita', () => {
    // Sem isto, o log de um bot que roda por meses (persistência já
    // existente, "logs/bots/<id>.log") cresceria sem limite entre os
    // ciclos de poda por IDADE do maintenanceManager (que só considera
    // arquivos com mais de 14 dias, nunca por TAMANHO) — um bot que
    // imprime muito podia estourar o disco bem antes disso.
    const botId = 'bot-console-rotation-test';
    const logDir = path.join(__dirname, '..', 'logs', 'bots');
    const logFile = path.join(logDir, `${botId}.log`);
    const oldFile = `${logFile}.old`;
    try { fs.unlinkSync(logFile); } catch { /* resíduo de execução anterior */ }
    try { fs.unlinkSync(oldFile); } catch { /* idem */ }

    try {
        // Simula um arquivo já acima do teto de 5MB (escrito direto, não via
        // addLog — não precisamos de 5MB de chamadas de função só pro teste).
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(logFile, Buffer.alloc(6 * 1024 * 1024, 'x'));

        addLog(botId, 'linha nova depois da rotação', 'stdout');

        assert.ok(fs.existsSync(oldFile), 'o arquivo antigo (>5MB) deveria ter sido rotacionado para .old');
        assert.ok(fs.statSync(oldFile).size >= 6 * 1024 * 1024);

        const newContent = fs.readFileSync(logFile, 'utf8');
        assert.ok(newContent.includes('linha nova depois da rotação'));
        assert.ok(newContent.length < 1024, 'o arquivo novo deveria conter só a linha nova, não arrastar o conteúdo antigo');
    } finally {
        try { fs.unlinkSync(logFile); } catch { /* ignore */ }
        try { fs.unlinkSync(oldFile); } catch { /* ignore */ }
    }
});

test('ROTAÇÃO SEGURA: arquivo ainda abaixo do teto não é tocado (não rotaciona à toa)', () => {
    const botId = 'bot-console-no-rotation-test';
    const logDir = path.join(__dirname, '..', 'logs', 'bots');
    const logFile = path.join(logDir, `${botId}.log`);
    const oldFile = `${logFile}.old`;
    try { fs.unlinkSync(logFile); } catch { /* ignore */ }
    try { fs.unlinkSync(oldFile); } catch { /* ignore */ }

    try {
        addLog(botId, 'linha única, arquivo pequeno', 'stdout');
        addLog(botId, 'segunda linha, ainda pequeno', 'stdout');

        assert.equal(fs.existsSync(oldFile), false, 'não deveria existir rotação — o arquivo nunca passou do teto');
        const content = fs.readFileSync(logFile, 'utf8');
        assert.ok(content.includes('linha única'));
        assert.ok(content.includes('segunda linha'));
    } finally {
        try { fs.unlinkSync(logFile); } catch { /* ignore */ }
        try { fs.unlinkSync(oldFile); } catch { /* ignore */ }
    }
});
