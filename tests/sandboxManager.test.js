const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decideBackend, createSandbox } = require('../src/managers/sandbox/SandboxManager');
const { detectCapabilities } = require('../src/managers/sandbox/capabilityDetector');

function withFakePlatform(fakePlatform, fn) {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: fakePlatform, configurable: true });
    try {
        return fn();
    } finally {
        Object.defineProperty(process, 'platform', original);
    }
}

test('decideBackend(): fora do Linux, sempre escolhe "process" rotulado reduced:true', () => {
    withFakePlatform('win32', () => {
        const decision = decideBackend();
        assert.equal(decision.name, 'process');
        assert.equal(decision.reduced, true);
        assert.ok(decision.reason.includes('reduzido'));
    });
});

test('decideBackend(): no Linux, reflete exatamente o que capabilityDetector diz — sem meio-termo e sem fallback silencioso', () => {
    const caps = detectCapabilities();
    if (!caps.isLinux) return; // este teste só faz sentido rodando em Linux
    const decision = decideBackend();
    if (caps.linuxSandboxReady) {
        assert.equal(decision.name, 'linux');
        assert.equal(decision.reduced, false);
    } else {
        // CRÍTICO: nunca deve cair pra 'process' só porque 'linux' falhou —
        // isso seria o fallback silencioso que foi explicitamente proibido.
        assert.equal(decision.name, null, 'Linux sem capacidades não deveria cair pra "process" — deveria recusar');
        assert.ok(decision.reason.length > 0);
    }
});

test('createSandbox(): decision.name === null sempre lança, nunca cria nada', async () => {
    await assert.rejects(
        () => createSandbox({ name: null, reason: 'motivo de teste' }, { id: 'x', folderPath: '/tmp', command: 'true', args: [], env: {} }),
        /motivo de teste/
    );
});

test('createSandbox(): decision "process" cria e roda um ProcessSandboxBackend de verdade', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxmgr-test-'));
    const sandbox = await createSandbox(
        { name: 'process', reduced: true, reason: null },
        { id: 'sandboxmgr-test', folderPath: dir, command: process.execPath, args: ['-e', 'console.log("via SandboxManager")'], env: {} }
    );
    assert.equal(sandbox.status().backend, 'process');
    await sandbox.start();
    await new Promise((resolve) => sandbox.once('exit', resolve));
    const logs = sandbox.logs().map((l) => l.line).join('');
    assert.ok(logs.includes('via SandboxManager'));
});

test('createSandbox(): decision "linux" cria um LinuxSandboxBackend real (ou falha fechado se este host não suportar — nunca outra coisa)', async () => {
    const caps = detectCapabilities();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandboxmgr-linux-test-'));
    if (!caps.isLinux || !caps.linuxSandboxReady) {
        // Ambiente sem suporte — confirma que criar com decision 'linux' à
        // força ainda assim falha fechado dentro do próprio backend (dupla
        // proteção: SandboxManager não deveria ter decidido 'linux' aqui,
        // mas se algo forçar essa decision mesmo assim, o backend recusa).
        await assert.rejects(() => createSandbox(
            { name: 'linux', reduced: false, reason: null },
            { id: 'sandboxmgr-linux-test', folderPath: dir, command: process.execPath, args: ['-e', '1'], env: {} }
        ));
        return;
    }
    const sandbox = await createSandbox(
        { name: 'linux', reduced: false, reason: null },
        { id: 'sandboxmgr-linux-test', folderPath: dir, command: process.execPath, args: ['-e', 'console.log("via SandboxManager Linux")'], env: {} }
    );
    assert.equal(sandbox.status().backend, 'linux');
    await sandbox.start();
    await new Promise((resolve) => sandbox.once('exit', resolve));
    const logs = sandbox.logs().map((l) => l.line).join('');
    assert.ok(logs.includes('via SandboxManager Linux'));
    await sandbox.destroy();
});
