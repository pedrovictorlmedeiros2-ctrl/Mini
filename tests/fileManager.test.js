const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listFiles, readFile, writeFile, deleteItem, renameItem } = require('../src/managers/fileManager');

function makeBotFolder() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-filemanager-test-'));
}

test('lê e escreve arquivos normalmente dentro da pasta do bot', () => {
    const folder = makeBotFolder();
    writeFile(folder, 'index.js', 'console.log(1)');
    assert.strictEqual(readFile(folder, 'index.js'), 'console.log(1)');
    const entries = listFiles(folder, '');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].name, 'index.js');
});

test('rejeita path traversal clássico (../)', () => {
    const folder = makeBotFolder();
    assert.throws(() => readFile(folder, '../../../etc/passwd'), /Caminho invalido/);
    assert.throws(() => writeFile(folder, '../../etc/pwned.txt', 'x'), /Caminho invalido/);
});

test('CORREÇÃO DE SEGURANÇA: rejeita escape via link simbólico plantado dentro da pasta do bot', () => {
    // Regressão do achado real: um bot podia criar um symlink dentro da
    // própria pasta apontando pra fora, e a checagem antiga (só string,
    // path.resolve não segue links) deixava passar.
    const folder = makeBotFolder();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'dado de outro bot ou do host');
    fs.symlinkSync(outside, path.join(folder, 'escape'));

    assert.throws(
        () => readFile(folder, 'escape/secret.txt'),
        /link simbólico/,
        'deve detectar e bloquear a leitura através do symlink'
    );
    assert.throws(
        () => writeFile(folder, 'escape/overwrite.txt', 'malicioso'),
        /link simbólico/,
        'deve detectar e bloquear a escrita através do symlink'
    );
    assert.strictEqual(fs.existsSync(path.join(outside, 'overwrite.txt')), false, 'nada deve ter sido escrito fora da pasta do bot');
});

test('deleteItem não permite apagar a raiz da pasta do bot', () => {
    const folder = makeBotFolder();
    assert.throws(() => deleteItem(folder, ''), /raiz/);
    assert.throws(() => deleteItem(folder, '.'), /raiz/);
});

test('renameItem rejeita nome novo contendo separador de caminho', () => {
    const folder = makeBotFolder();
    writeFile(folder, 'a.txt', 'x');
    assert.throws(() => renameItem(folder, 'a.txt', '../b.txt'), /Nome invalido/);
    assert.throws(() => renameItem(folder, 'a.txt', 'sub/b.txt'), /Nome invalido/);
});

test('permite criar arquivo em caminho novo cujo diretório ainda não existe', () => {
    const folder = makeBotFolder();
    writeFile(folder, 'src/commands/ping.js', 'module.exports = {}');
    assert.strictEqual(readFile(folder, 'src/commands/ping.js'), 'module.exports = {}');
});
