/**
 * CONTAINER MANAGER — Isolamento real por bot (Docker)
 *
 * Quando USE_CONTAINERS=true e o Docker estiver disponível, cada bot roda
 * dentro de um container com:
 *  - memória limitada (--memory)
 *  - CPU limitada (--cpus)
 *  - filesystem isolado (volume bind só da pasta do bot)
 *  - rede dedicada isolada, sem comunicação entre containers (ver
 *    ensureTenantNetwork abaixo)
 *  - read-only rootfs + tmpfs para /tmp
 *  - no-new-privileges + todas as capabilities Linux removidas
 *
 * Fallback: se Docker não estiver disponível, retorna null e o processManager
 * usa o spawn clássico (compatibilidade total).
 *
 * CORREÇÃO DE SEGURANÇA (achado em auditoria): a versão anterior usava a rede
 * "bridge" padrão do Docker pra TODOS os containers de bots. Isso significa
 * que o bot do Cliente A conseguia alcançar o container do Cliente B
 * diretamente pela rede (scan de porta, HTTP direto, etc.) — o isolamento de
 * filesystem/CPU/RAM não protege contra um bot atacando outro pela rede.
 * Confirmado em teste real com dois containers: um lia dados do outro sem
 * passar por nenhuma checagem de autorização. Corrigido com uma rede
 * dedicada (`atlantic-host-tenants`) com `com.docker.network.bridge.enable_icc=false`
 * — os containers continuam com acesso normal à internet (NAT via o host),
 * só não conseguem mais se enxergar entre si.
 */
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { get } = require('../database/database');

const execFileAsync = promisify(execFile);

const CONTAINER_PREFIX = 'hostbot-';
let dockerAvailable = null;

async function isDockerAvailable() {
    if (dockerAvailable !== null) return dockerAvailable;
    try {
        await execFileAsync('docker', ['info'], { timeout: 5000 });
        dockerAvailable = true;
    } catch {
        dockerAvailable = false;
    }
    return dockerAvailable;
}

const TENANT_NETWORK = 'atlantic-host-tenants';
let tenantNetworkReady = null;

async function ensureTenantNetwork() {
    if (tenantNetworkReady) return tenantNetworkReady;
    tenantNetworkReady = (async () => {
        try {
            const { stdout } = await execFileAsync('docker', ['network', 'ls', '--filter', `name=^${TENANT_NETWORK}$`, '--format', '{{.Name}}']);
            if (stdout.trim() === TENANT_NETWORK) return;
        } catch { /* segue e tenta criar */ }
        try {
            await execFileAsync('docker', [
                'network', 'create',
                '--driver', 'bridge',
                '--opt', 'com.docker.network.bridge.enable_icc=false',
                TENANT_NETWORK,
            ]);
        } catch (err) {
            // Corrida entre múltiplos starts simultâneos criando a rede ao
            // mesmo tempo — se já existe, não é erro de verdade.
            if (!/already exists/i.test(err.message || '')) throw err;
        }
    })();
    return tenantNetworkReady;
}

function containerName(botId) {
    const safe = String(botId).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40);
    return `${CONTAINER_PREFIX}${safe}`;
}

function resolveImage(bot) {
    if (bot.language === 'python') {
        return process.env.CONTAINER_IMAGE_PYTHON || 'atlantic-host-python:3.12';
    }
    const major = bot.node_version ? String(bot.node_version).split('.')[0] : '22';
    if (process.env.CONTAINER_IMAGE_NODE) return process.env.CONTAINER_IMAGE_NODE;
    // Prefer custom prewarmed image, fallback to official
    return `atlantic-host-node:${major}`;
}

function buildContainerCommand(bot) {
    const isPython = bot.language === 'python';
    const mainFile = bot.main_file || (isPython ? 'main.py' : 'index.js');

    if (isPython) {
        return [
            'sh', '-c',
            `if [ -x .venv/bin/python ]; then .venv/bin/python ${mainFile}; else python ${mainFile}; fi`,
        ];
    }

    const ramMB = bot.max_memory || parseInt(process.env.MAX_RAM_PER_BOT, 10) || 512;
    return ['node', `--max-old-space-size=${ramMB}`, mainFile];
}

async function startInContainer(bot, opts = {}) {
    if (!(await isDockerAvailable())) return null;
    
    // Suporte para receber botId ou objeto bot
    const botObj = typeof bot === 'string' ? get('SELECT * FROM bots WHERE id = ?', [bot]) : bot;
    if (!botObj) throw new Error('Bot não encontrado para container');

    const name = containerName(botObj.id);
    const folderPath = path.resolve(botObj.folder_path);
    if (!fs.existsSync(folderPath)) {
        throw new Error('Pasta do bot não encontrada para container');
    }

    try {
        await execFileAsync('docker', ['rm', '-f', name], { timeout: 10000 });
    } catch { /* ok */ }

    // CONTAINER_NETWORK no .env é um escape-hatch avançado — se alguém
    // apontar de volta pra "bridge" (a rede padrão do Docker), perde a
    // proteção contra um bot alcançar o container de outro bot pela rede.
    // Por isso o default agora é a rede isolada, não mais "bridge".
    if (!process.env.CONTAINER_NETWORK) {
        await ensureTenantNetwork();
    } else if (process.env.CONTAINER_NETWORK === 'bridge') {
        console.warn('[containerManager] ⚠️ CONTAINER_NETWORK=bridge remove o isolamento entre bots de clientes diferentes. Use a rede dedicada (padrão) a menos que você saiba exatamente o que está fazendo.');
    }

    const ramMB = opts.ramMB || botObj.max_memory || 512;
    const cpuLimit = opts.cpuLimit || botObj.max_cpu_limit || 50;
    const cpus = Math.max(0.05, Math.min(4, cpuLimit / 100));
    const image = resolveImage(botObj);
    const cmd = buildContainerCommand(botObj);

    const envArgs = [];
    for (const [k, v] of Object.entries(opts.env || {})) {
        if (v === undefined || v === null) continue;
        envArgs.push('-e', `${k}=${String(v)}`);
    }

    const dockerArgs = [
        'run', '-d',
        '--name', name,
        '--memory', `${ramMB}m`,
        '--memory-swap', `${ramMB}m`,
        '--cpus', String(cpus),
        '--pids-limit', '256',
        '--security-opt', 'no-new-privileges:true',
        '--cap-drop', 'ALL',
        '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '--network', process.env.CONTAINER_NETWORK || TENANT_NETWORK,
        '--restart', 'no',
        '-v', `${folderPath}:/app:rw`,
        '-w', '/app',
        ...envArgs,
        image,
        ...cmd,
    ];

    if (botObj.port) {
        dockerArgs.splice(2, 0, '-p', `${botObj.port}:${botObj.internal_port || botObj.port}`);
    }

    const { stdout } = await execFileAsync('docker', dockerArgs, {
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
    });

    return { containerId: stdout.trim(), name };
}

async function stopContainer(botId) {
    if (!(await isDockerAvailable())) return false;
    try {
        await execFileAsync('docker', ['rm', '-f', containerName(botId)], { timeout: 15000 });
        return true;
    } catch {
        return false;
    }
}

async function getContainerStatus(botId) {
    if (!(await isDockerAvailable())) return null;
    const name = containerName(botId);
    try {
        const { stdout } = await execFileAsync(
            'docker',
            ['inspect', '-f', '{{.State.Status}}|{{.State.Pid}}|{{.Id}}', name],
            { timeout: 5000 }
        );
        const [status, pid, id] = stdout.trim().split('|');
        return { status, pid: parseInt(pid, 10) || 0, id, name };
    } catch {
        return { status: 'not_found', pid: 0, id: null, name };
    }
}

async function getContainerLogs(botId, lines = 80) {
    if (!(await isDockerAvailable())) return null;
    try {
        const { stdout } = await execFileAsync(
            'docker',
            ['logs', '--tail', String(lines), containerName(botId)],
            { timeout: 8000, maxBuffer: 2 * 1024 * 1024 }
        );
        return stdout;
    } catch {
        return null;
    }
}

function followContainerLogs(botId, onData) {
    const proc = spawn('docker', ['logs', '-f', '--tail', '20', containerName(botId)], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => onData(d, 'stdout'));
    proc.stderr.on('data', (d) => onData(d, 'stderr'));
    return proc;
}

async function getContainerStats(botId) {
    if (!(await isDockerAvailable())) return null;
    try {
        const { stdout } = await execFileAsync(
            'docker',
            ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', containerName(botId)],
            { timeout: 5000 }
        );
        const [cpuStr, memStr] = stdout.trim().split('|');
        const cpu = parseFloat(String(cpuStr).replace('%', '')) || 0;
        const used = parseFloat(String(memStr).split('/')[0]) || 0;
        return { cpu, ramMB: used };
    } catch {
        return null;
    }
}

function containersEnabled() {
    const v = String(process.env.USE_CONTAINERS || '').toLowerCase();
    return v === 'true' || v === '1';
}

module.exports = {
    isDockerAvailable,
    containersEnabled,
    startInContainer,
    stopContainer,
    getContainerStatus,
    getContainerLogs,
    followContainerLogs,
    getContainerStats,
    containerName,
    ensureTenantNetwork,
    TENANT_NETWORK,
};
