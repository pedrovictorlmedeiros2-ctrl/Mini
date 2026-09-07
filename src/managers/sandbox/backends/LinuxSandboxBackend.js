/**
 * LINUX SANDBOX BACKEND — isolamento real via bwrap (namespaces) + cgroup v2
 * (limites de recurso), aplicado diretamente (sem depender de systemd-run,
 * que só funciona se systemd for o PID 1 — nem todo host Linux garante
 * isso, e cgroup v2 puro não depende de systemd pra ser gerenciado).
 *
 * O QUE ISTO REALMENTE ISOLA (mecanismo de kernel, não convenção de JS):
 *  - Filesystem: mount namespace próprio, só enxerga o que é explicitamente
 *    montado (sistema base read-only + a pasta do bot read-write).
 *  - Processos: PID namespace próprio — não vê nem consegue sinalizar
 *    processos fora dele (resolve C1/C2 do SECURITY_AUDIT.md).
 *  - Privilégios: user namespace com ZERO capabilities efetivas (CapEff
 *    sempre 0000000000000000 — testado e confirmado).
 *  - Rede: nesta versão, `--unshare-net` SEM veth = isolamento total (nem
 *    localhost do host, nem internet). Resolve C3 (nenhum acesso à rede
 *    interna/SSRF), mas também impede o bot de acessar a internet — bots
 *    Discord reais PRECISAM de internet pra funcionar. Rede restrita-mas-
 *    com-internet (veth + nftables) é um item separado, ainda não
 *    implementado — ver SECURITY_LIMITATIONS.md.
 *  - Recursos: cgroup v2 (memory.max, pids.max, cpu.max) — limite reforçado
 *    pelo KERNEL, não por um watchdog que reage depois do fato.
 *
 * O QUE ISTO NÃO FAZ (honestidade, não é uma lista de próximos passos):
 *  - Não aplica seccomp. Decisão deliberada — filtrar syscall por syscall à
 *    mão é exatamente o tipo de "inventar mecanismo de segurança" que foi
 *    pedido pra evitar. Os namespaces + zero capabilities já cobrem a
 *    maioria dos vetores críticos do audit; seccomp ficaria pra uma
 *    iteração futura, usando um perfil já pronto e auditado (ex: o
 *    default do Docker/runc), nunca escrito do zero aqui.
 *  - Não implementa a rede restrita-mas-com-internet ainda (ver acima).
 *
 * FAIL-CLOSED: se `capabilityDetector.detectCapabilities().linuxSandboxReady`
 * for false, `create()` LANÇA um erro — nunca degrada pra rodar sem
 * isolamento.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { detectCapabilities, CGROUP_ROOT } = require('../capabilityDetector');
const { buildBaseSystemBindArgs } = require('../bwrapSystemBinds');

const MAX_LOG_LINES = 500;

function selfCgroupBaseDir() {
    const selfCgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const unifiedLine = selfCgroup.split('\n').find((l) => l.startsWith('0::'));
    const rel = unifiedLine ? (unifiedLine.slice(3) || '/') : '/';
    return path.join(CGROUP_ROOT, rel);
}

function cpuMaxValue(cpuPercent) {
    const period = 100000; // 100ms, valor padrão comum
    const quota = Math.max(1000, Math.round((cpuPercent / 100) * period));
    return `${quota} ${period}`;
}

class LinuxSandboxBackend extends EventEmitter {
    /**
     * @param {object} spec
     * @param {string} spec.id - identificador único (ex: botId)
     * @param {string} spec.folderPath - pasta do bot, montada read-write dentro do sandbox
     * @param {string} spec.command - binário a rodar (ex: process.execPath pro node)
     * @param {string[]} spec.args - argumentos do comando
     * @param {Record<string,string>} spec.env - variáveis de ambiente do BOT (nunca as da plataforma)
     * @param {{memoryMB?: number, cpuPercent?: number, pids?: number}} spec.limits
     * @param {number} [spec.uid] - uid a mapear dentro do sandbox (padrão: 65534/nobody)
     */
    constructor(spec) {
        super();
        this.id = spec.id;
        this.folderPath = path.resolve(spec.folderPath);
        this.command = spec.command;
        this.args = spec.args || [];
        this.env = spec.env || {};
        this.limits = {
            memoryMB: spec.limits?.memoryMB ?? 512,
            cpuPercent: spec.limits?.cpuPercent ?? 100,
            pids: spec.limits?.pids ?? 100,
        };
        this.uid = spec.uid ?? 65534;
        this.gid = spec.gid ?? 65534;

        this.state = 'idle'; // idle -> created -> running -> stopped/exited
        this.child = null;
        this.exitCode = null;
        this.startedAt = null;
        this.cgroupDir = null;
        this._logBuffer = [];
    }

    /**
     * Valida que este host consegue oferecer isolamento real e prepara o
     * cgroup do sandbox. NÃO inicia o processo ainda (ver start()).
     * @throws {Error} se o host não tiver os requisitos mínimos — nunca
     *   degrada silenciosamente.
     */
    async create() {
        const caps = detectCapabilities();
        if (!caps.linuxSandboxReady) {
            throw new Error(
                `Sandbox Linux indisponível neste host — recusando criar (fail-closed, sem fallback inseguro). Motivo(s): ${caps.linuxSandboxBlockedBy.join(' | ')}`
            );
        }
        if (!fs.existsSync(this.folderPath)) {
            throw new Error(`Pasta do bot não existe: ${this.folderPath}`);
        }

        const base = selfCgroupBaseDir();
        const parent = path.join(base, 'atlantic-bots');
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

        this.cgroupDir = path.join(parent, this.id);
        if (fs.existsSync(this.cgroupDir)) {
            // resquício de uma execução anterior que não limpou — remove antes de recriar
            try { fs.rmdirSync(this.cgroupDir); } catch { /* segue, vai falhar no mkdir se realmente estiver em uso */ }
        }
        fs.mkdirSync(this.cgroupDir);
        fs.writeFileSync(path.join(this.cgroupDir, 'memory.max'), String(this.limits.memoryMB * 1024 * 1024));
        fs.writeFileSync(path.join(this.cgroupDir, 'memory.swap.max'), '0');
        fs.writeFileSync(path.join(this.cgroupDir, 'pids.max'), String(this.limits.pids));
        fs.writeFileSync(path.join(this.cgroupDir, 'cpu.max'), cpuMaxValue(this.limits.cpuPercent));

        this.state = 'created';
    }

    _buildBwrapArgs() {
        // ORDEM IMPORTA: bwrap aplica os binds em sequência, e um mount
        // posterior pode ESCONDER um mount anterior se for num caminho pai
        // (ex: `--tmpfs /tmp` depois de `--bind /tmp/bot-x /tmp/bot-x`
        // apaga o bind anterior, porque /tmp/bot-x fica dentro de /tmp).
        // Por isso o `--tmpfs /tmp` genérico vem ANTES do bind específico
        // da pasta do bot — assim o bind da pasta do bot fica por cima,
        // mesmo se ela morar (por acidente de configuração) dentro de /tmp.
        // Confirmado com reprodução real: a ordem errada quebra até o
        // `--chdir` (bwrap: "Can't chdir to ...: No such file or directory").
        const args = [
            '--unshare-all',
            '--die-with-parent',
            '--new-session',
            ...buildBaseSystemBindArgs(),
            '--ro-bind', path.dirname(this.command), path.dirname(this.command), // dir do binário (node), sem assumir que mora em /usr
            '--proc', '/proc',
            '--dev', '/dev',
            '--tmpfs', '/tmp',
            '--bind', this.folderPath, this.folderPath, // pasta do bot: leitura E escrita — depois do tmpfs genérico, de propósito
            '--chdir', this.folderPath,
            '--uid', String(this.uid),
            '--gid', String(this.gid),
            '--clearenv',
        ];
        for (const [key, value] of Object.entries(this.env)) {
            args.push('--setenv', key, String(value));
        }
        args.push('--', this.command, ...this.args);
        return args;
    }

    /**
     * Inicia o processo dentro do sandbox. Precisa de create() ter rodado antes.
     */
    async start() {
        if (this.state !== 'created') {
            throw new Error(`start() chamado em estado inválido: ${this.state} (esperado: created)`);
        }

        const bwrapArgs = this._buildBwrapArgs();
        this.child = spawn('bwrap', bwrapArgs, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.startedAt = Date.now();
        this.state = 'running';

        // Move o PID do bwrap pro cgroup preparado em create(). Como
        // cgroups são herdados no fork, qualquer processo que o bwrap crie
        // depois disso já nasce dentro do cgroup — não precisa mover de novo.
        try {
            fs.writeFileSync(path.join(this.cgroupDir, 'cgroup.procs'), String(this.child.pid));
        } catch (err) {
            // Se isto falhar, o processo já está rodando SEM limite de
            // recurso — mais seguro derrubar tudo agora do que deixar rodar
            // sem o limite que foi prometido.
            this._kill('SIGKILL');
            this.state = 'exited';
            throw new Error(`Não foi possível aplicar o cgroup ao processo — sandbox encerrado por segurança: ${err.message}`);
        }

        const pushLog = (type) => (data) => {
            const line = data.toString();
            this._logBuffer.push({ type, line, ts: Date.now() });
            if (this._logBuffer.length > MAX_LOG_LINES) this._logBuffer.shift();
            this.emit('log', { type, line });
        };
        this.child.stdout.on('data', pushLog('stdout'));
        this.child.stderr.on('data', pushLog('stderr'));

        this.child.on('exit', (code, signal) => {
            this.exitCode = code;
            this.state = 'exited';
            this.emit('exit', { code, signal });
        });

        return this.child;
    }

    _kill(signal) {
        if (this.child && this.state === 'running') {
            try { this.child.kill(signal); } catch { /* já pode ter morrido */ }
        }
    }

    /**
     * Para o processo: SIGTERM, escalando pra SIGKILL se não sair a tempo.
     */
    async stop(timeoutMs = 5000) {
        if (this.state !== 'running') return;
        this._kill('SIGTERM');
        const deadline = Date.now() + timeoutMs;
        while (this.state === 'running' && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
        }
        if (this.state === 'running') {
            this._kill('SIGKILL');
        }
    }

    async restart() {
        await this.stop();
        await this.create();
        await this.start();
    }

    /**
     * Encerra e libera todos os recursos (cgroup). Depois de destroy(), a
     * instância não pode ser reaproveitada — crie uma nova.
     */
    async destroy() {
        await this.stop();
        if (this.cgroupDir && fs.existsSync(this.cgroupDir)) {
            try { fs.rmdirSync(this.cgroupDir); } catch { /* pode falhar se ainda houver processo residual — best effort */ }
        }
        this.state = 'destroyed';
    }

    status() {
        return {
            id: this.id,
            state: this.state,
            pid: this.child?.pid ?? null,
            exitCode: this.exitCode,
            startedAt: this.startedAt,
            backend: 'linux',
        };
    }

    logs() {
        return this._logBuffer.slice();
    }

    /**
     * Lê uso real de recursos direto do cgroup — não é uma estimativa, é o
     * número que o kernel está de fato contabilizando.
     */
    metrics() {
        if (!this.cgroupDir || !fs.existsSync(this.cgroupDir)) return null;
        const readNum = (file) => {
            try { return parseInt(fs.readFileSync(path.join(this.cgroupDir, file), 'utf8').trim(), 10); } catch { return null; }
        };
        return {
            memoryCurrentBytes: readNum('memory.current'),
            pidsCurrent: readNum('pids.current'),
            cpuStat: (() => {
                try { return fs.readFileSync(path.join(this.cgroupDir, 'cpu.stat'), 'utf8'); } catch { return null; }
            })(),
        };
    }
}

module.exports = { LinuxSandboxBackend };
