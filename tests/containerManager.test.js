const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { isDockerAvailable, ensureTenantNetwork, TENANT_NETWORK } = require('../src/managers/containerManager');

// Regressão de um achado real de segurança: containers de bots de clientes
// diferentes, ambos na rede "bridge" padrão do Docker, conseguiam se
// alcançar diretamente pela rede (um lia dados do outro sem passar por
// nenhuma checagem de autorização da aplicação). Estes testes precisam de
// Docker de verdade — em máquinas de desenvolvimento sem Docker instalado,
// pulam graciosamente em vez de falhar (o resto da suíte não depende dele).

test('rede dedicada de tenants existe com inter-container communication desabilitada', async (t) => {
    if (!(await isDockerAvailable())) {
        t.skip('Docker não disponível nesta máquina — pulando teste que depende dele.');
        return;
    }
    await ensureTenantNetwork();
    const { stdout } = await execFileAsync('docker', ['network', 'inspect', TENANT_NETWORK]);
    const [info] = JSON.parse(stdout);
    assert.strictEqual(info.Options && info.Options['com.docker.network.bridge.enable_icc'], 'false');
});

test('dois containers na rede de tenants não conseguem se alcançar pela rede', async (t) => {
    if (!(await isDockerAvailable())) {
        t.skip('Docker não disponível nesta máquina — pulando teste que depende dele.');
        return;
    }
    await ensureTenantNetwork();

    const cleanup = [];
    try {
        await execFileAsync('docker', [
            'run', '-d', '--name', 'atlantic-test-victim', '--network', TENANT_NETWORK,
            'node:20-alpine', 'node', '-e',
            "require('http').createServer((q,r)=>r.end('dado-privado-do-outro-bot')).listen(8080)",
        ]);
        cleanup.push('atlantic-test-victim');

        await execFileAsync('docker', [
            'run', '-d', '--name', 'atlantic-test-attacker', '--network', TENANT_NETWORK,
            'node:20-alpine', 'sh', '-c', 'sleep 30',
        ]);
        cleanup.push('atlantic-test-attacker');

        // dá um tempo pro servidor da "vítima" subir
        await new Promise((r) => setTimeout(r, 2000));

        const { stdout: inspectOut } = await execFileAsync('docker', [
            'inspect', '-f', `{{(index .NetworkSettings.Networks "${TENANT_NETWORK}").IPAddress}}`, 'atlantic-test-victim',
        ]);
        const victimIp = inspectOut.trim();

        let attackerOutput = '';
        try {
            const { stdout } = await execFileAsync('docker', [
                'exec', 'atlantic-test-attacker', 'wget', '-T', '2', '-O', '-', `http://${victimIp}:8080`,
            ]);
            attackerOutput = stdout;
        } catch {
            // esperado: a conexão deve falhar/dar timeout (bloqueada pela rede)
        }

        assert.ok(
            !attackerOutput.includes('dado-privado-do-outro-bot'),
            'um container não pode ler dados de outro container pela rede, mesmo estando na mesma rede Docker'
        );
    } finally {
        for (const name of cleanup) {
            try { await execFileAsync('docker', ['rm', '-f', name]); } catch { /* já removido */ }
        }
    }
});
