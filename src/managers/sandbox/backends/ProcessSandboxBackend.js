/**
 * PROCESS SANDBOX BACKEND — isolamento REDUZIDO (best-effort), sem
 * mecanismo de kernel nenhum. É exatamente o que processManager.js já
 * fazia antes desta refatoração: spawn() direto do processo, com
 * security_wrapper.js injetado via --require (Node) e cpulimit/nice como
 * limite de CPU quando disponíveis.
 *
 * NÃO É UMA SANDBOX DE VERDADE. Existe pra dois casos:
 *  1. Windows — onde namespaces/cgroups não existem, esta é a ÚNICA opção.
 *  2. Documentação honesta do nível de proteção real quando o
 *     SandboxManager escolhe este backend (ver decideBackend()).
 *
 * O comando/argumentos/env já chegam TOTALMENTE resolvidos de quem chama
 * (processManager.js) — este backend não decide qual runtime usar, só
 * spawna o que foi mandado. Isso mantém o mesmo contrato do
 * LinuxSandboxBackend (que também recebe tudo já resolvido), então
 * SandboxManager pode tratar os dois de forma intercambiável.
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const MAX_LOG_LINES = 500;

class ProcessSandboxBackend extends EventEmitter {
    /**
     * @param {object} spec
     * @param {string} spec.id
     * @param {string} spec.folderPath
     * @param {string} spec.command
     * @param {string[]} spec.args
     * @param {Record<string,string>} spec.env
     */
    constructor(spec) {
        super();
        this.id = spec.id;
        this.folderPath = spec.folderPath;
        this.command = spec.command;
        this.args = spec.args || [];
        this.env = spec.env || {};

        this.state = 'idle';
        this.child = null;
        this.exitCode = null;
        this.startedAt = null;
        this._logBuffer = [];
    }

    /**
     * Sem requisito de host — este backend está sempre "disponível" (é
     * exatamente por isso que não é uma sandbox real). Só existe como
     * método pra manter a mesma interface do LinuxSandboxBackend.
     */
    async create() {
        this.state = 'created';
    }

    async start() {
        if (this.state !== 'created') {
            throw new Error(`start() chamado em estado inválido: ${this.state} (esperado: created)`);
        }

        this.child = spawn(this.command, this.args, {
            cwd: this.folderPath,
            env: this.env,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        this.startedAt = Date.now();
        this.state = 'running';

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
        this.child.on('error', (err) => {
            this.state = 'exited';
            this.emit('error', err);
        });

        return this.child;
    }

    _kill(signal) {
        if (this.child && this.state === 'running') {
            try { this.child.kill(signal); } catch { /* já pode ter morrido */ }
        }
    }

    async stop(timeoutMs = 5000) {
        if (this.state !== 'running') return;
        this._kill('SIGTERM');
        const deadline = Date.now() + timeoutMs;
        while (this.state === 'running' && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
        }
        if (this.state === 'running') {
            this._kill('SIGKILL');
            const killDeadline = Date.now() + 2000;
            while (this.state === 'running' && Date.now() < killDeadline) {
                await new Promise((r) => setTimeout(r, 100));
            }
        }
    }

    async restart() {
        await this.stop();
        await this.create();
        await this.start();
    }

    async destroy() {
        await this.stop();
        this.state = 'destroyed';
    }

    status() {
        return {
            id: this.id,
            state: this.state,
            pid: this.child?.pid ?? null,
            exitCode: this.exitCode,
            startedAt: this.startedAt,
            backend: 'process',
            reduced: true,
        };
    }

    logs() {
        return this._logBuffer.slice();
    }

    /**
     * Sem cgroup, sem número confiável de uso de recurso — retorna null de
     * propósito em vez de fingir uma métrica que não existe de verdade
     * (quem chama já deve ter fallback pro pidusage tradicional).
     */
    metrics() {
        return null;
    }
}

module.exports = { ProcessSandboxBackend };
