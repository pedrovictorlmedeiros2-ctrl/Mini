const test = require('node:test');
const assert = require('node:assert/strict');
const { validateZipEntries } = require('../src/utils/zipValidation');

// Ajuda a criar "entradas de zip" falsas sem precisar de um .zip de verdade
function entry(entryName, sizeBytes) {
    return { entryName, header: { size: sizeBytes } };
}

test('zip normal e pequeno passa sem erro', () => {
    const entries = [entry('index.js', 1000), entry('package.json', 200)];
    assert.doesNotThrow(() => validateZipEntries(entries, '/bots/meu-bot', {}));
});

test('zip-slip: caminho tentando escapar da pasta é recusado', () => {
    const entries = [entry('../../etc/passwd', 100)];
    assert.throws(
        () => validateZipEntries(entries, '/bots/meu-bot', {}),
        /zip-slip/
    );
});

test('zip-slip: caminho absoluto disfarçado é recusado', () => {
    const entries = [entry('../../../../root/.ssh/authorized_keys', 100)];
    assert.throws(
        () => validateZipEntries(entries, '/bots/meu-bot', {}),
        /zip-slip/
    );
});

test('zip-slip CRÍTICO: barra invertida escapa no Windows mesmo sem escapar no Linux — achado em teste de invasão real', () => {
    // No Windows (onde o Atlantic Host roda de verdade), path.resolve() trata
    // '\' como separador de pasta de verdade. Um zip malicioso pode usar '\'
    // no nome da entrada pra escapar da pasta do bot e alcançar o .env do
    // próprio host, mesmo que o formato zip "oficial" só preveja '/'.
    const entries = [entry('..\\..\\..\\Users\\junio\\Desktop\\atlantic-host\\.env', 100)];
    assert.throws(
        () => validateZipEntries(entries, '/bots/meu-bot', {}),
        /barra invertida/
    );
});

test('zip-slip: pasta com nome literal "...." não é um escape real, só um nome estranho', () => {
    // Diferente de '..' (que sobe um nível), '....' é só um nome de pasta
    // válido — não deve ser bloqueado, pois nunca sai da pasta do bot.
    const entries = [entry('..../..../..../etc/passwd', 100)];
    assert.doesNotThrow(() => validateZipEntries(entries, '/bots/meu-bot', {}));
});

test('zip bomb: tamanho descompactado acima do limite é recusado', () => {
    // simula um zip pequeno que, uma vez descompactado, passa de 300MB
    const entries = [entry('arquivo-gigante.bin', 500 * 1024 * 1024)];
    assert.throws(
        () => validateZipEntries(entries, '/bots/meu-bot', { maxUnzippedSizeMB: 300 }),
        /descompactado/
    );
});

test('zip bomb: soma de vários arquivos pequenos também é barrada', () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(`arquivo${i}.bin`, 50 * 1024 * 1024));
    // 10 x 50MB = 500MB > limite de 300MB
    assert.throws(
        () => validateZipEntries(entries, '/bots/meu-bot', { maxUnzippedSizeMB: 300 }),
        /descompactado/
    );
});

test('zip bomb: quantidade de arquivos acima do limite é recusada', () => {
    const entries = Array.from({ length: 3000 }, (_, i) => entry(`f${i}.js`, 10));
    assert.throws(
        () => validateZipEntries(entries, '/bots/meu-bot', { maxEntries: 2000 }),
        /arquivos demais/
    );
});

test('zip dentro dos limites configurados passa', () => {
    const entries = [entry('index.js', 10 * 1024 * 1024)]; // 10MB
    assert.doesNotThrow(() =>
        validateZipEntries(entries, '/bots/meu-bot', { maxEntries: 2000, maxUnzippedSizeMB: 300 })
    );
});
