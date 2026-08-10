const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { statFile, writeFile } = require('../src/managers/fileManager');

// Regressão de um bug introduzido (e pego) durante o próprio desenvolvimento
// do painel do cliente: uma rota HTTP checava o tamanho do arquivo com
// fs.statSync(path.resolve(botFolder, filePath)) direto, sem passar pela
// mesma validação de safeResolve usada por readFile/writeFile — reabrindo
// path traversal (e criando um oráculo de existência de arquivo fora da
// pasta do bot) só nesse um lugar. statFile() precisa ter exatamente a
// mesma proteção que o resto do módulo.

test('statFile funciona normalmente para arquivo dentro da pasta do bot', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-statfile-'));
    writeFile(folder, 'a.txt', 'conteudo');
    const stat = statFile(folder, 'a.txt');
    assert.ok(stat);
    assert.strictEqual(stat.size, 'conteudo'.length);
});

test('statFile retorna null pra arquivo que não existe dentro da pasta', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-statfile-'));
    assert.strictEqual(statFile(folder, 'nao-existe.txt'), null);
});

test('statFile rejeita path traversal em vez de vazar existência/tamanho de arquivo do host', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-statfile-'));
    // /etc/hostname existe de verdade na máquina — se statFile não bloqueasse
    // o traversal, isso teria retornado um stat válido em vez de lançar.
    assert.throws(() => statFile(folder, '../../../../../../etc/hostname'));
});
