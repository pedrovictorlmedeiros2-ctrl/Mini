const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LinuxSandboxBackend } = require('../src/managers/sandbox/backends/LinuxSandboxBackend');
const { detectCapabilities } = require('../src/managers/sandbox/capabilityDetector');
const networkManager = require('../src/managers/sandbox/networkManager');

const caps = detectCapabilities();
const bwrapWorks = caps.isLinux && caps.bwrap.available && caps.userNamespaces.available;
const networkWorks = caps.isLinux && caps.nft.available && caps.networking.available;

/**
 * `_buildBwrapArgs()` sempre inclui `--block-fd 3` (ver LinuxSandboxBackend.js
 * — é o mecanismo real usado pra configurar rede antes do processo do bot
 * executar uma linha sequer). Isso significa que rodar os args direto com
 * `execFileSync` sem fornecer/desbloquear o fd 3 trava o bwrap pra sempre.
 * Este helper spawna com o pipe extra e desbloqueia imediatamente (pros
 * testes que não precisam testar rede) ou depois de rodar `onInnerPid`
 * (pros que precisam).
 */
function runBwrap(args, { timeoutMs = 8000, env, onInnerPid } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn('bwrap', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env });
        let out = '';
        child.stdout.on('data', (d) => { out += d.toString(); });
        child.stderr.on('data', (d) => { out += d.toString(); });

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`timeout esperando bwrap terminar. Saída parcial: ${out}`));
        }, timeoutMs);

        child.on('exit', () => {
            clearTimeout(timer);
            resolve(out);
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        (async () => {
            if (onInnerPid) {
                const innerPid = await findInnerPidForTest(child.pid);
                if (innerPid) {
                    try { await onInnerPid(innerPid); } catch { /* deixa o teste ver o resultado via a própria saída/asserção */ }
                }
            }
            try {
                child.stdio[3].write('x');
                child.stdio[3].end();
            } catch { /* processo já pode ter morrido */ }
        })();
    });
}

async function findInnerPidForTest(outerPid, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
        try {
            const content = fs.readFileSync(`/proc/${outerPid}/task/${outerPid}/children`, 'utf8').trim();
            if (content) return parseInt(content.split(/\s+/)[0], 10);
        } catch { break; }
        await new Promise((r) => setTimeout(r, 25));
    }
    return null;
}

// IMPORTANTE (rigor pedido): estes testes se dividem em duas categorias.
//
// 1) Testes que usam `_buildBwrapArgs()` diretamente + spawn manual de
//    bwrap — validam a MECÂNICA REAL de isolamento (filesystem, processos,
//    capabilities, rede) SEM depender de cgroup v2. Rodam de verdade neste
//    ambiente (bwrap funciona aqui) e provam kernel-level isolation.
//
// 2) Testes do fluxo completo create()->start() — esses SIM dependem de
//    cgroup v2 com delegação de escrita (ver SECURITY_AUDIT.md/relatório
//    desta fase: este ambiente de desenvolvimento específico NÃO tem
//    delegação de cgroup v2, então create() vai reportar indisponível e
//    LANÇAR — esse é o comportamento CORRETO e esperado (fail-closed), não
//    uma falha de teste. Só uma VPS Linux real, com systemd como PID 1 e
//    cgroup v2 unificado, valida create()/start() executando de verdade.

function makeBackend(overrides = {}) {
    return new LinuxSandboxBackend({
        id: overrides.id ?? ('test-' + Math.random().toString(36).slice(2)),
        folderPath: overrides.folderPath || fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-')),
        command: process.execPath,
        args: overrides.args || ['-e', 'console.log("ok")'],
        env: overrides.env || {},
        limits: { memoryMB: 128, cpuPercent: 50, pids: 20 },
    });
}

test('create() recusa (fail-closed) quando o host não tem os 3 requisitos — nunca degrada silenciosamente', async () => {
    const backend = makeBackend();
    if (caps.linuxSandboxReady) {
        // Só acontece numa VPS real com tudo disponível — nesse caso
        // create() DEVE funcionar, e limpamos depois.
        await backend.create();
        assert.equal(backend.state, 'created');
        await backend.destroy();
    } else {
        await assert.rejects(() => backend.create(), /Sandbox Linux indisponível.*fail-closed/);
    }
});

test('_buildBwrapArgs() sempre inclui --unshare-all, --clearenv e --die-with-parent', { skip: !bwrapWorks }, () => {
    const backend = makeBackend();
    const args = backend._buildBwrapArgs();
    assert.ok(args.includes('--unshare-all'));
    assert.ok(args.includes('--clearenv'));
    assert.ok(args.includes('--die-with-parent'));
});

test('ISOLAMENTO REAL: processo dentro do sandbox NÃO enxerga arquivo fora da pasta do bot', { skip: !bwrapWorks }, async () => {
    const secretDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-secret-'));
    fs.writeFileSync(path.join(secretDir, 'segredo.txt'), 'nao-pode-vazar');

    const backend = makeBackend({ args: ['-e', `try { require('fs').readFileSync(${JSON.stringify(path.join(secretDir, 'segredo.txt'))}, 'utf8'); console.log('VULNERAVEL'); } catch (e) { console.log('BLOQUEADO'); }`] });
    const out = await runBwrap(backend._buildBwrapArgs());
    assert.ok(out.includes('BLOQUEADO'), `esperava bloqueio, saída: ${out}`);
    assert.ok(!out.includes('VULNERAVEL'));
});

test('ISOLAMENTO REAL: processo dentro do sandbox CONSEGUE ler/escrever dentro da própria pasta', { skip: !bwrapWorks }, async () => {
    const backend = makeBackend({ args: ['-e', `const fs=require('fs'); fs.writeFileSync('teste.txt','conteudo'); console.log('OK:' + fs.readFileSync('teste.txt','utf8'));`] });
    const out = await runBwrap(backend._buildBwrapArgs());
    assert.ok(out.includes('OK:conteudo'), `esperava sucesso dentro da própria pasta, saída: ${out}`);
});

test('ISOLAMENTO REAL: PID namespace — processo não vê a árvore de processos do host', { skip: !bwrapWorks }, async () => {
    const backend = makeBackend({ args: ['-e', `console.log('meu pid: ' + process.pid); console.log('conteudo de /proc:'); console.log(require('fs').readdirSync('/proc').filter(x => /^\\d+$/.test(x)).join(','));`] });
    const out = await runBwrap(backend._buildBwrapArgs());
    // Dentro do PID namespace isolado, só o próprio processo (e talvez o
    // bwrap "init") aparecem em /proc — nunca dezenas/centenas de PIDs do
    // host real.
    const pidsSeen = out.match(/conteudo de \/proc:\n([\d,]*)/)?.[1]?.split(',').filter(Boolean) ?? [];
    assert.ok(pidsSeen.length <= 3, `esperava ver poucos PIDs (namespace isolado), viu: ${pidsSeen.join(',')}`);
});

test('ISOLAMENTO REAL: zero capabilities efetivas dentro do sandbox', { skip: !bwrapWorks }, async () => {
    const backend = makeBackend({ args: ['-e', `console.log(require('fs').readFileSync('/proc/self/status','utf8').split('\\n').find(l => l.startsWith('CapEff')))`] });
    const out = await runBwrap(backend._buildBwrapArgs());
    assert.match(out, /CapEff:\s*0000000000000000/, `esperava CapEff zerado, saída: ${out}`);
});

test('ISOLAMENTO REAL: sem rede configurada (só --block-fd desbloqueado, sem veth), não alcança um servidor real do host', { skip: !bwrapWorks }, async () => {
    const http = require('http');
    const server = http.createServer((_req, res) => res.end('segredo-do-host-nao-pode-vazar'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const backend = makeBackend({ args: ['-e', `
        const http = require('http');
        const req = http.get('http://127.0.0.1:${port}', (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => console.log('VULNERAVEL:' + data));
        });
        req.on('error', () => console.log('BLOQUEADO'));
        req.setTimeout(2000, () => { console.log('BLOQUEADO'); process.exit(0); });
    `] });
    let out;
    try {
        out = await runBwrap(backend._buildBwrapArgs());
    } finally {
        server.close();
    }
    assert.ok(out.includes('BLOQUEADO'), `esperava bloqueio de rede, saída: ${out}`);
    assert.ok(!out.includes('VULNERAVEL'));
});

test('ISOLAMENTO REAL: --clearenv impede vazamento de variável de ambiente do processo externo', { skip: !bwrapWorks }, async () => {
    const backend = makeBackend({
        env: { BOT_VAR: 'valor-do-bot' },
        args: ['-e', `console.log('BOT_VAR=' + process.env.BOT_VAR); console.log('SEGREDO_PLATAFORMA=' + (process.env.SEGREDO_PLATAFORMA_DE_FORA ?? 'ausente'));`],
    });
    const out = await runBwrap(backend._buildBwrapArgs(), {
        env: { ...process.env, SEGREDO_PLATAFORMA_DE_FORA: 'nao-pode-vazar', PATH: process.env.PATH },
    });
    assert.ok(out.includes('BOT_VAR=valor-do-bot'), 'variável explícita do bot deveria estar presente');
    assert.ok(out.includes('SEGREDO_PLATAFORMA=ausente'), `--clearenv deveria impedir herança do ambiente externo, saída: ${out}`);
});

test('REDE RESTRITA (veth + nftables): sandbox alcança a internet real, mas não o "control-plane" do host', {
    skip: !networkWorks ? 'requer nft + veth/nsenter funcionais (CAP_NET_ADMIN) — não disponíveis neste ambiente' : false,
}, async () => {
    const http = require('http');
    const server = http.createServer((_req, res) => res.end('SEGREDO_CONTROL_PLANE'));
    await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
    const port = server.address().port;

    const allocation = networkManager.allocateSubnet('test-net-' + Math.random().toString(36).slice(2));
    const backend = makeBackend({ args: ['-e', `
        const http = require('http');
        function tryReach(name, url) {
            return new Promise((resolve) => {
                const req = http.get(url, { timeout: 3000 }, (res) => {
                    let d = ''; res.on('data', c => d += c);
                    res.on('end', () => { console.log(name + ':CONSEGUIU:' + d); resolve(); });
                });
                req.on('error', (e) => { console.log(name + ':BLOQUEADO:' + e.message); resolve(); });
                req.on('timeout', () => { console.log(name + ':BLOQUEADO:timeout'); req.destroy(); resolve(); });
            });
        }
        (async () => {
            await tryReach('internet', 'http://1.1.1.1');
            await tryReach('control-plane', 'http://${allocation.hostIp}:${port}');
        })();
    `] });

    let out;
    try {
        out = await runBwrap(backend._buildBwrapArgs(), {
            onInnerPid: async (innerPid) => networkManager.attachNetwork(allocation, innerPid),
        });
    } finally {
        server.close();
        networkManager.detachNetwork(allocation);
    }

    assert.match(out, /internet:CONSEGUIU/, `esperava conseguir alcançar a internet de verdade, saída: ${out}`);
    assert.match(out, /control-plane:BLOQUEADO/, `esperava bloqueio ao tentar alcançar o "host" via IP de gateway, saída: ${out}`);
    assert.ok(!out.includes('SEGREDO_CONTROL_PLANE'), 'segredo do control-plane não pode aparecer na saída de jeito nenhum');
});

test('REDE RESTRITA: dois sandboxes não conseguem se alcançar (isolamento cross-tenant)', {
    skip: !networkWorks ? 'requer nft + veth/nsenter funcionais (CAP_NET_ADMIN) — não disponíveis neste ambiente' : false,
}, async () => {
    // Sandbox B (a "vítima"): só fica escutando, esperando ser desbloqueado
    const allocB = networkManager.allocateSubnet('test-net-b-' + Math.random().toString(36).slice(2));
    const backendB = makeBackend({ args: ['-e', `
        require('http').createServer((q,r)=>r.end('SEGREDO_DO_OUTRO_BOT')).listen(9777, '0.0.0.0', () => {
            console.log('vitima no ar');
        });
        setTimeout(() => process.exit(0), 4000);
    `] });

    const victimPromise = runBwrap(backendB._buildBwrapArgs(), {
        timeoutMs: 6000,
        onInnerPid: async (innerPid) => networkManager.attachNetwork(allocB, innerPid),
    });

    await new Promise((r) => setTimeout(r, 500)); // dá tempo da vítima subir e escutar

    // Sandbox A (o "atacante"): tenta alcançar a vítima pelo IP dela
    const allocA = networkManager.allocateSubnet('test-net-a-' + Math.random().toString(36).slice(2));
    const backendA = makeBackend({ args: ['-e', `
        const req = require('http').get('http://${allocB.botIp}:9777', { timeout: 2000 }, (res) => {
            let d=''; res.on('data',c=>d+=c); res.on('end', () => console.log('VULNERAVEL:' + d));
        });
        req.on('error', (e) => console.log('BLOQUEADO:' + e.message));
        req.on('timeout', () => { console.log('BLOQUEADO:timeout'); req.destroy(); });
    `] });

    let outA;
    try {
        outA = await runBwrap(backendA._buildBwrapArgs(), {
            onInnerPid: async (innerPid) => networkManager.attachNetwork(allocA, innerPid),
        });
    } finally {
        await victimPromise.catch(() => {});
        networkManager.detachNetwork(allocA);
        networkManager.detachNetwork(allocB);
    }

    assert.match(outA, /BLOQUEADO/, `esperava que o bot A não alcançasse o bot B, saída: ${outA}`);
    assert.ok(!outA.includes('SEGREDO_DO_OUTRO_BOT'), 'um bot nunca pode ler dado de outro bot pela rede');
});

test('LIMITE DE RECURSO (cgroup v2): memory.max realmente derruba o processo ao estourar o limite', {
    skip: !caps.linuxSandboxReady ? 'requer cgroup v2 com delegação de escrita — não disponível neste ambiente de desenvolvimento (ver SECURITY_AUDIT.md / relatório da Fase 3). Só valida de verdade numa VPS Linux real.' : false,
}, async () => {
    const backend = makeBackend({
        args: ['-e', `
            const chunks = [];
            const iv = setInterval(() => {
                chunks.push(Buffer.alloc(20 * 1024 * 1024).fill(1)); // 20MB por vez
            }, 50);
        `],
    });
    backend.limits.memoryMB = 64; // bem abaixo do que o loop vai tentar alocar
    await backend.create();
    await backend.start();
    const exited = await new Promise((resolve) => {
        backend.once('exit', resolve);
        setTimeout(() => resolve(null), 10000);
    });
    assert.ok(exited, 'processo deveria ter sido derrubado pelo cgroup por estourar memory.max');
    await backend.destroy();
});

test('LIMITE DE RECURSO (cgroup v2): pids.max impede fork bomb dentro do sandbox', {
    skip: !caps.linuxSandboxReady ? 'requer cgroup v2 com delegação de escrita — não disponível neste ambiente de desenvolvimento. Só valida de verdade numa VPS Linux real.' : false,
}, async () => {
    const backend = makeBackend({
        args: ['-e', `
            const { spawnSync } = require('child_process');
            let count = 0;
            try {
                for (let i = 0; i < 500; i++) {
                    spawnSync('/bin/true');
                    count++;
                }
            } catch (e) { /* esperado: pids.max deve barrar em algum ponto */ }
            console.log('processos criados antes de barrar: ' + count);
        `],
    });
    backend.limits.pids = 10;
    await backend.create();
    await backend.start();
    await new Promise((resolve) => backend.once('exit', resolve));
    const logs = backend.logs().map((l) => l.line).join('');
    const match = logs.match(/processos criados antes de barrar: (\d+)/);
    assert.ok(match, `esperava ver a contagem no log, saída: ${logs}`);
    assert.ok(Number(match[1]) < 500, 'pids.max deveria ter impedido de criar todos os 500 processos');
    await backend.destroy();
});

test('REGRESSÃO (auditoria Fase 3): id com path traversal é rejeitado no construtor — impede escapar do diretório de cgroup', () => {
    const maliciousIds = ['../../../../tmp/evil', '/etc/passwd', 'a/b', 'a b', '', 'x'.repeat(65)];
    for (const id of maliciousIds) {
        assert.throws(
            () => makeBackend({ id }),
            /id de sandbox inválido/,
            `id ${JSON.stringify(id)} deveria ter sido rejeitado`
        );
    }
    // ids legítimos (o formato real usado por generateId()) continuam funcionando
    assert.doesNotThrow(() => makeBackend({ id: 'bot-abc123_XYZ' }));
});

test('REGRESSÃO (auditoria Fase 3): CapBnd (bounding set) fica zerado, não só CapEff/CapPrm', { skip: !bwrapWorks }, () => {
    const backend = makeBackend({ args: ['-e', `console.log(require('fs').readFileSync('/proc/self/status','utf8').split('\\n').filter(l => l.startsWith('Cap')).join('|'))`] });
    const out = execFileSync('bwrap', backend._buildBwrapArgs(), { timeout: 8000 }).toString();
    for (const field of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
        assert.match(out, new RegExp(`${field}:\\s*0000000000000000`), `${field} deveria estar zerado, saída: ${out}`);
    }
});

test('REGRESSÃO (auditoria Fase 3): hostname dentro do sandbox é próprio, não o do host real', { skip: !bwrapWorks }, () => {
    const realHostname = os.hostname();
    const backend = makeBackend({ args: ['-e', `console.log(require('os').hostname())`] });
    const out = execFileSync('bwrap', backend._buildBwrapArgs(), { timeout: 8000 }).toString().trim();
    assert.notEqual(out, realHostname, 'hostname do sandbox não deveria vazar o hostname real do host');
    assert.ok(out.startsWith('sandbox-'), `esperava hostname prefixado 'sandbox-', veio: ${out}`);
});

test('REGRESSÃO (auditoria Fase 3): stop() só retorna depois do processo realmente morrer (evita corrida com destroy()/rmdir do cgroup)', { skip: !bwrapWorks }, async () => {
    const backend = makeBackend({ args: ['-e', 'setInterval(() => {}, 1000)'] }); // fica vivo até ser morto
    const bwrapArgs = backend._buildBwrapArgs();
    // Bypassa create() (que exige cgroup v2 real) só pra testar stop()
    // isoladamente — start() de verdade é coberto pelos testes de recurso
    // acima, que dependem de cgroup. Precisa do 4º stdio (--block-fd 3) e
    // desbloquear na mão, senão o bwrap fica parado pra sempre.
    backend.child = spawn('bwrap', bwrapArgs, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    backend.child.stdio[3].write('x');
    backend.child.stdio[3].end();
    backend.state = 'running';
    backend.child.on('exit', () => { backend.state = 'exited'; });

    await new Promise((r) => setTimeout(r, 300)); // dá tempo do processo subir de verdade

    await backend.stop(1000); // timeout curto, força escalar pra SIGKILL

    assert.equal(backend.state, 'exited', 'stop() deveria só retornar depois do processo realmente sair, não na hora do kill()');
    // confirma independentemente que o PID de fato não existe mais no host
    assert.throws(() => process.kill(backend.child.pid, 0), 'o processo deveria estar morto de verdade no SO, não só marcado como tal internamente');
});

test('status()/logs()/metrics() antes de start() não quebram (estado idle/created)', () => {
    const backend = makeBackend();
    const status = backend.status();
    assert.equal(status.state, 'idle');
    assert.deepEqual(backend.logs(), []);
    assert.equal(backend.metrics(), null);
});
