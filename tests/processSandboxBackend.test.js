const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ProcessSandboxBackend } = require('../src/managers/sandbox/backends/ProcessSandboxBackend');

function makeBackend(overrides = {}) {
    return new ProcessSandboxBackend({
        id: overrides.id ?? 'test-process-sandbox',
        folderPath: overrides.folderPath || fs.mkdtempSync(path.join(os.tmpdir(), 'process-sandbox-test-')),
        command: process.execPath,
        args: overrides.args || ['-e', 'console.log("ok")'],
        env: overrides.env || {},
    });
}

test('create() sempre funciona (sem requisito de host — é o modo reduzido)', async () => {
    const backend = makeBackend();
    await backend.create();
    assert.equal(backend.state, 'created');
});

test('start() executa o processo de verdade e captura stdout', async () => {
    const backend = makeBackend({ args: ['-e', 'console.log("linha de teste")'] });
    await backend.create();
    await backend.start();
    await new Promise((resolve) => backend.once('exit', resolve));
    const logs = backend.logs().map((l) => l.line).join('');
    assert.ok(logs.includes('linha de teste'), `esperava a linha no log, veio: ${logs}`);
});

test('env é passado corretamente pro processo', async () => {
    const backend = makeBackend({ env: { MEU_VAR: 'valor123' }, args: ['-e', 'console.log("VAR=" + process.env.MEU_VAR)'] });
    await backend.create();
    await backend.start();
    await new Promise((resolve) => backend.once('exit', resolve));
    const logs = backend.logs().map((l) => l.line).join('');
    assert.ok(logs.includes('VAR=valor123'));
});

test('stop() derruba um processo de longa duração', async () => {
    const backend = makeBackend({ args: ['-e', 'setInterval(() => {}, 1000)'] });
    await backend.create();
    await backend.start();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(backend.state, 'running');
    await backend.stop(1000);
    assert.equal(backend.state, 'exited');
});

test('metrics() retorna null honestamente (sem cgroup, sem métrica confiável)', async () => {
    const backend = makeBackend();
    assert.equal(backend.metrics(), null);
});

test('status() reporta backend "process" e reduced:true — nunca finge ser uma sandbox real', async () => {
    const backend = makeBackend();
    const status = backend.status();
    assert.equal(status.backend, 'process');
    assert.equal(status.reduced, true);
});
