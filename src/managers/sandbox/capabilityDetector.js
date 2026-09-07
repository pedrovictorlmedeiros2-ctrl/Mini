/**
 * CAPABILITY DETECTOR — checa, de verdade (não por suposição), o que este
 * host consegue oferecer de isolamento real.
 *
 * Princípio (Fase 13 do pedido original): nunca assumir que um mecanismo
 * está disponível só porque o SO é Linux. Cada capacidade abaixo é testada
 * na prática (tentando USAR o mecanismo, não só checando se o binário
 * existe) — porque "bwrap instalado" não significa "consigo criar um user
 * namespace aqui" (containers aninhados, políticas de kernel restritivas,
 * AppArmor/SELinux bloqueando unprivileged_userns_clone, etc. podem negar
 * isso mesmo com o binário presente).
 *
 * IMPORTANTE: o resultado deste módulo pode (e deve) variar entre
 * ambientes. Um container de CI/dev aninhado pode reportar `cgroupV2.
 * delegationWritable: false` mesmo com bwrap funcionando perfeitamente,
 * porque cgroups não foram delegados a esse container — isso é awaited e
 * correto, não um bug. Só um host Linux "de verdade" (VPS normal, com
 * systemd como PID 1, sem estar dentro de outro container restritivo) deve
 * reportar tudo disponível.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildBaseSystemBindArgs } = require('./bwrapSystemBinds');

const CGROUP_ROOT = '/sys/fs/cgroup';

function tryExec(bin, args, opts = {}) {
    try {
        return { ok: true, output: execFileSync(bin, args, { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString() };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * bwrap: checa presença + versão, e faz um teste funcional real (roda um
 * processo isolado de verdade, não só `--version`).
 */
function detectBwrap() {
    const versionCheck = tryExec('bwrap', ['--version']);
    if (!versionCheck.ok) {
        return { available: false, version: null, functionalTest: false, reason: 'binário `bwrap` não encontrado ou não executável' };
    }
    const version = versionCheck.output.trim();

    // Teste funcional: roda de verdade um processo dentro de namespaces
    // isolados, usando os mesmos binds de sistema que o LinuxSandboxBackend
    // vai usar de verdade (ver bwrapSystemBinds.js — cobre tanto usrmerge
    // quanto FHS tradicional).
    const functional = tryExec('bwrap', [
        '--unshare-all', '--die-with-parent',
        ...buildBaseSystemBindArgs(),
        '--proc', '/proc',
        '--dev', '/dev',
        '--tmpfs', '/tmp',
        '--uid', '65534', '--gid', '65534',
        '/bin/true',
    ]);

    return {
        available: functional.ok,
        version,
        functionalTest: functional.ok,
        reason: functional.ok ? null : `bwrap presente mas falhou ao criar sandbox de teste: ${functional.error}`,
    };
}

/**
 * User namespaces: `unshare --user` precisa funcionar de verdade. Kernels
 * com `kernel.unprivileged_userns_clone=0` (Debian antigo, algumas
 * distros hardened) ou AppArmor bloqueando isso vão falhar aqui mesmo com
 * o binário presente.
 */
function detectUserNamespaces() {
    const result = tryExec('unshare', ['--user', '--map-root-user', 'true']);
    return {
        available: result.ok,
        reason: result.ok ? null : `unshare --user falhou: ${result.error} (possíveis causas: kernel.unprivileged_userns_clone=0, AppArmor/SELinux, ou já dentro de um container que não permite namespace aninhado)`,
    };
}

/**
 * cgroup v2: não basta o arquivo existir — precisa ter os controllers
 * necessários habilitados E ser gravável de verdade (delegação). Testa
 * criando um cgroup filho real, escrevendo os três limites que o
 * SandboxManager usa, e removendo em seguida.
 */
function detectCgroupV2() {
    const controllersFile = path.join(CGROUP_ROOT, 'cgroup.controllers');
    if (!fs.existsSync(controllersFile)) {
        return { available: false, delegationWritable: false, controllers: [], reason: 'cgroup v2 unificado não está montado em ' + CGROUP_ROOT };
    }

    let controllers = [];
    try {
        controllers = fs.readFileSync(controllersFile, 'utf8').trim().split(/\s+/).filter(Boolean);
    } catch (err) {
        return { available: false, delegationWritable: false, controllers: [], reason: `não foi possível ler cgroup.controllers: ${err.message}` };
    }

    const required = ['memory', 'pids', 'cpu'];
    const missing = required.filter((c) => !controllers.includes(c));
    if (missing.length > 0) {
        return { available: false, delegationWritable: false, controllers, reason: `controllers ausentes no cgroup v2: ${missing.join(', ')}` };
    }

    // Encontra o cgroup do PRÓPRIO processo (é dentro dele que teríamos
    // permissão de criar filhos, se houver delegação).
    let selfCgroupPath = '/';
    try {
        const selfCgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
        const unifiedLine = selfCgroup.split('\n').find((l) => l.startsWith('0::'));
        if (unifiedLine) selfCgroupPath = unifiedLine.slice(3) || '/';
    } catch { /* segue com '/' */ }

    const baseDir = path.join(CGROUP_ROOT, selfCgroupPath);
    const probeDir = path.join(baseDir, `atlantic-probe-${crypto.randomBytes(4).toString('hex')}`);

    try {
        fs.mkdirSync(probeDir);
        fs.writeFileSync(path.join(probeDir, 'memory.max'), '50000000');
        fs.writeFileSync(path.join(probeDir, 'pids.max'), '20');
        fs.writeFileSync(path.join(probeDir, 'cpu.max'), '50000 100000');
        fs.rmdirSync(probeDir);
        return { available: true, delegationWritable: true, controllers, reason: null, testedAt: baseDir };
    } catch (err) {
        try { fs.rmdirSync(probeDir); } catch { /* ignore cleanup failure */ }
        return {
            available: true, // controllers existem no sistema
            delegationWritable: false, // mas não temos delegação de escrita aqui
            controllers,
            reason: `cgroup v2 tem os controllers certos, mas não há delegação de escrita em ${baseDir}: ${err.message}`,
        };
    }
}

function detectNft() {
    const result = tryExec('nft', ['--version']);
    return { available: result.ok, reason: result.ok ? null : 'binário `nft` (nftables) não encontrado — necessário pra política de rede restrita (Fase 7)' };
}

function detectSystemd() {
    const result = tryExec('systemd-run', ['--version']);
    if (!result.ok) return { available: false, reason: 'binário `systemd-run` não encontrado' };
    // Presença do binário não significa que systemd é o PID 1 de verdade
    // (comum em containers de dev/CI) — só systemd-run funcionalmente
    // importa se formos usá-lo; hoje o backend usa cgroup v2 direto, então
    // isto é só informativo.
    return { available: true, reason: null };
}

/**
 * Roda todas as detecções e decide se o LinuxSandboxBackend pode ser usado
 * de verdade neste host. TODAS as condições abaixo são obrigatórias — não
 * existe modo "parcialmente disponível" que ainda assim rode bot.
 */
function detectCapabilities() {
    const platform = process.platform;
    const isLinux = platform === 'linux';

    const result = {
        platform,
        isLinux,
        checkedAt: new Date().toISOString(),
        bwrap: { available: false },
        userNamespaces: { available: false },
        cgroupV2: { available: false, delegationWritable: false },
        nft: { available: false },
        systemd: { available: false },
        linuxSandboxReady: false,
        linuxSandboxBlockedBy: [],
    };

    if (!isLinux) {
        result.linuxSandboxBlockedBy.push(`plataforma é '${platform}', não Linux — namespaces/cgroups não existem fora do Linux.`);
        return result;
    }

    result.bwrap = detectBwrap();
    result.userNamespaces = detectUserNamespaces();
    result.cgroupV2 = detectCgroupV2();
    result.nft = detectNft();
    result.systemd = detectSystemd();

    if (!result.bwrap.available) result.linuxSandboxBlockedBy.push(`bwrap: ${result.bwrap.reason}`);
    if (!result.userNamespaces.available) result.linuxSandboxBlockedBy.push(`user namespaces: ${result.userNamespaces.reason}`);
    if (!result.cgroupV2.delegationWritable) result.linuxSandboxBlockedBy.push(`cgroup v2: ${result.cgroupV2.reason}`);

    result.linuxSandboxReady = result.linuxSandboxBlockedBy.length === 0;

    return result;
}

module.exports = {
    detectCapabilities,
    detectBwrap,
    detectUserNamespaces,
    detectCgroupV2,
    detectNft,
    detectSystemd,
    CGROUP_ROOT,
};
