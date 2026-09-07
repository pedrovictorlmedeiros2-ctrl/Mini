const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
    detectCapabilities,
    detectBwrap,
    detectUserNamespaces,
    detectCgroupV2,
    CGROUP_ROOT,
} = require('../src/managers/sandbox/capabilityDetector');

function hasBinary(bin) {
    try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; }
}

// IMPORTANTE: estes testes verificam que o detector reporta a VERDADE deste
// ambiente especificamente — não fixam um resultado esperado (ex: "bwrap
// deve estar disponível"), porque isso varia legitimamente entre máquinas.
// O que se testa é: o detector não mente sobre o que ele mesmo consegue
// fazer, verificado com uma segunda tentativa independente na própria
// bateria de teste.

test('detectCapabilities() sempre retorna a forma esperada, em qualquer SO', () => {
    const caps = detectCapabilities();
    assert.equal(typeof caps.platform, 'string');
    assert.equal(typeof caps.isLinux, 'boolean');
    assert.equal(typeof caps.linuxSandboxReady, 'boolean');
    assert.ok(Array.isArray(caps.linuxSandboxBlockedBy));
    if (!caps.isLinux) {
        assert.equal(caps.linuxSandboxReady, false);
        assert.ok(caps.linuxSandboxBlockedBy.length > 0);
    }
});

test('linuxSandboxReady só é true se bwrap, user namespaces E cgroup v2 (com delegação de escrita) estiverem todos disponíveis', () => {
    const caps = detectCapabilities();
    if (!caps.isLinux) return;
    const allGood = caps.bwrap.available && caps.userNamespaces.available && caps.cgroupV2.delegationWritable;
    assert.equal(caps.linuxSandboxReady, allGood, 'linuxSandboxReady precisa refletir exatamente o AND das 3 condições — nenhuma pode faltar silenciosamente');
    if (!allGood) {
        assert.ok(caps.linuxSandboxBlockedBy.length > 0, 'se não está pronto, tem que listar POR QUE (nunca falhar silenciosamente)');
    }
});

test('detectBwrap(): se reporta disponível, um teste independente rodado aqui também tem que funcionar', { skip: process.platform !== 'linux' }, () => {
    const result = detectBwrap();
    if (!hasBinary('bwrap')) {
        assert.equal(result.available, false, 'bwrap não está instalado neste ambiente de teste — resultado esperado é false, não um crash nem um "true" otimista');
        return;
    }
    // bwrap está instalado — confirma independentemente que o detector não
    // está mentindo sobre o teste funcional
    if (result.available) {
        const { buildBaseSystemBindArgs } = require('../src/managers/sandbox/bwrapSystemBinds');
        assert.doesNotThrow(() => {
            execFileSync('bwrap', [
                '--unshare-all', '--die-with-parent',
                ...buildBaseSystemBindArgs(),
                '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
                '--uid', '65534', '--gid', '65534',
                '/bin/true',
            ], { timeout: 5000 });
        }, 'detector disse que bwrap funciona, mas uma tentativa independente idêntica falhou');
    }
});

test('detectUserNamespaces(): consistente com uma tentativa independente de unshare --user', { skip: process.platform !== 'linux' || !hasBinary('unshare') }, () => {
    const result = detectUserNamespaces();
    let independentlyWorks = true;
    try {
        execFileSync('unshare', ['--user', '--map-root-user', 'true'], { timeout: 5000, stdio: 'ignore' });
    } catch {
        independentlyWorks = false;
    }
    assert.equal(result.available, independentlyWorks);
});

test('detectCgroupV2(): se reporta delegationWritable=true, um mkdir+write+rmdir independente no MESMO local também funciona', { skip: process.platform !== 'linux' }, () => {
    const result = detectCgroupV2();
    if (!result.delegationWritable) {
        // Ambiente sem delegação de cgroup v2 (comum em containers de
        // dev/CI aninhados, incluindo o ambiente onde este código foi
        // escrito) — resultado esperado e correto é false. Documentar isso
        // é o ponto central desta fase: NÃO fingir que está disponível.
        assert.equal(result.delegationWritable, false);
        return;
    }
    // Só chega aqui numa máquina que realmente delega cgroup v2 — confirma
    // de verdade, não confia cegamente no detector
    let selfCgroupPath = '/';
    const selfCgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const unifiedLine = selfCgroup.split('\n').find((l) => l.startsWith('0::'));
    if (unifiedLine) selfCgroupPath = unifiedLine.slice(3) || '/';
    const probeDir = path.join(CGROUP_ROOT, selfCgroupPath, 'atlantic-test-independente');
    fs.mkdirSync(probeDir);
    fs.writeFileSync(path.join(probeDir, 'memory.max'), '50000000');
    fs.rmdirSync(probeDir);
});

test('CAPABILITY REPORT (informativo — mostra o que este ambiente específico suporta, sem falhar o teste)', () => {
    const caps = detectCapabilities();
    console.log('\n--- Relatório de capacidades deste ambiente ---');
    console.log(JSON.stringify(caps, null, 2));
    console.log('------------------------------------------------\n');
    assert.ok(caps); // sempre passa — isto é só pra visibilidade no log de CI
});
