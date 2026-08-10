const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-console.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { addLog, getRecentLogs, consoleEvents } = require('../src/managers/consoleManager');

test('addLog atualiza o buffer em memória e é lido por getRecentLogs', () => {
    addLog('bot-console-test-1', 'primeira linha', 'stdout');
    const logs = getRecentLogs('bot-console-test-1');
    assert.ok(logs.includes('primeira linha'));
});

test('addLog emite um evento line:<botId> pra quem está inscrito (usado pelo console ao vivo via SSE)', () => {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('evento não emitido a tempo')), 1000);
        consoleEvents.once('line:bot-console-test-2', (payload) => {
            clearTimeout(timeout);
            try {
                assert.strictEqual(payload.line, 'linha ao vivo');
                assert.strictEqual(payload.type, 'stdout');
                assert.strictEqual(typeof payload.timestamp, 'number');
                resolve();
            } catch (err) {
                reject(err);
            }
        });
        addLog('bot-console-test-2', 'linha ao vivo', 'stdout');
    });
});

test('addLog não emite evento pra um botId diferente do inscrito (sem vazamento entre bots)', () => {
    return new Promise((resolve, reject) => {
        const onWrongBot = () => reject(new Error('recebeu evento de outro bot — vazamento entre inscrições'));
        consoleEvents.once('line:bot-console-test-other', onWrongBot);
        addLog('bot-console-test-3', 'linha de um bot diferente', 'stdout');
        setTimeout(() => {
            consoleEvents.off('line:bot-console-test-other', onWrongBot);
            resolve();
        }, 200);
    });
});
