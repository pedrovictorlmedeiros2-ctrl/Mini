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
 *  - Rede: cada bot tem uma rede ponto-a-ponto própria (par veth, ver
 *    networkManager.js), com saída pra internet via NAT — mas bloqueada
 *    de alcançar outros bots, a rede privada do host, endpoints de
 *    metadata de cloud, e o próprio processo do Atlantic Host (regras
 *    nftables aplicadas uma vez, no host). Resolve C3 (SSRF/rede interna)
 *    sem deixar o bot cego pra internet, que bots Discord reais precisam.
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
const networkManager = require('../networkManager');

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

/**
 * Acha o PID que REALMENTE entrou nos namespaces novos — não é o PID que
 * spawn() retorna (esse é um processo supervisor externo do bwrap, que
 * fica FORA de qualquer namespace novo por design, pra poder implementar
 * --die-with-parent). É um FILHO dele. Usa /proc/<pid>/task/<pid>/children
 * (exposto pelo kernel, sem precisar de `pgrep` ou varrer todo /proc).
 * Tenta algumas vezes com um pequeno intervalo — o fork acontece bem no
 * início da execução do bwrap, mas não é instantâneo o suficiente pra
 * garantir que já existe no exato instante em que spawn() retorna.
 */
async function findInnerPid(outerPid, { attempts = 20, intervalMs = 25 } = {}) {
    const childrenFile = `/proc/${outerPid}/task/${outerPid}/children`;
    for (let i = 0; i < attempts; i++) {
        try {
            const content = fs.readFileSync(childrenFile, 'utf8').trim();
            if (content) return parseInt(content.split(/\s+/)[0], 10);
        } catch {
            // processo pai pode já ter saído (erro no bwrap) — para de tentar
            break;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
}

// CORREÇÃO DE SEGURANÇA (auditoria da Fase 3): `id` é usado pra montar o
// caminho do diretório de cgroup via path.join(parent, id). path.join()
// NÃO impede '..' — um id malicioso tipo '../../../../tmp/evil' faz
// create() tentar mkdir/escrever fora da árvore de cgroup pretendida.
// Hoje quem chama esta classe usa generateId() (seguro), mas a classe em
// si não validava nada — corrigido aqui, na fronteira, pra não depender de
// todo chamador futuro lembrar de validar.
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function assertSafeId(id) {
    if (typeof id !== 'string' || !SAFE_ID_PATTERN.test(id)) {
        throw new Error(`id de sandbox inválido: ${JSON.stringify(id)} — só letras, números, '_' e '-' são aceitos (máx 64 caracteres), pra impedir path traversal no diretório de cgroup.`);
    }
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
        assertSafeId(spec.id);
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
        this.network = null;
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

        // CORREÇÃO: restart() chama create() de novo sem passar por
        // destroy() — sem isto, a alocação de rede da execução anterior
        // nunca era liberada, vazando um índice de sub-rede a cada
        // restart (o cgroup não tinha esse problema porque o caminho é
        // determinístico pelo id e create() já limpa o resquício antes de
        // recriar; a alocação de rede em memória precisa do mesmo cuidado
        // explícito).
        if (this.network) {
            networkManager.detachNetwork(this.network);
            this.network = null;
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

        // CORREÇÃO (auditoria da Fase 3): se qualquer uma destas escritas
        // falhar (ex: swap accounting desligado no kernel, permissão
        // inesperada), o diretório de cgroup já criado ficava pra trás sem
        // limpeza — um resquício órfão a cada falha. Agora qualquer falha
        // aqui remove o diretório antes de propagar o erro.
        try {
            fs.writeFileSync(path.join(this.cgroupDir, 'memory.max'), String(this.limits.memoryMB * 1024 * 1024));
            fs.writeFileSync(path.join(this.cgroupDir, 'memory.swap.max'), '0');
            fs.writeFileSync(path.join(this.cgroupDir, 'pids.max'), String(this.limits.pids));
            fs.writeFileSync(path.join(this.cgroupDir, 'cpu.max'), cpuMaxValue(this.limits.cpuPercent));
        } catch (err) {
            try { fs.rmdirSync(this.cgroupDir); } catch { /* best effort */ }
            this.cgroupDir = null;
            throw new Error(`Falha ao aplicar limites de cgroup — sandbox não criado (fail-closed): ${err.message}`);
        }

        // Reserva o endereçamento de rede (não cria nada no SO ainda — só
        // decide qual /30 este bot vai usar). A criação de fato do veth
        // acontece em start(), depois do bwrap já estar rodando (ver
        // networkManager.js pra entender por que a ordem é essa).
        try {
            this.network = networkManager.allocateSubnet(this.id);
        } catch (err) {
            try { fs.rmdirSync(this.cgroupDir); } catch { /* best effort */ }
            this.cgroupDir = null;
            throw new Error(`Falha ao alocar rede do sandbox — sandbox não criado (fail-closed): ${err.message}`);
        }

        this.state = 'created';
    }

    _buildBwrapArgs() {
        // ORDEM IMPORTA: bwrap aplica os binds em sequência, e um mount
        // posterior pode ESCONDER um mount anterior se for num caminho pai
        // (ex: `--tmpfs /tmp` depois de `--bind /tmp/bot-x /tmp/bot-x`
        // apaga o bind anterior, porque /tmp/bot-x fica dentro de /tmp).
        // Confirmado com reprodução real: a ordem errada chega a quebrar o
        // `--chdir` (bwrap: "Can't chdir to ...: No such file or directory").
        // Por isso todo mount "genérico" (--proc, --dev, --tmpfs /tmp) vem
        // ANTES de qualquer bind específico (pasta do bot, dir do binário
        // node) — assim os binds específicos sempre ficam por cima, não
        // importa se algum deles mora (por acidente de configuração)
        // dentro de /tmp.
        const args = [
            '--unshare-all',
            '--die-with-parent',
            '--new-session',
            // CORREÇÃO DE SEGURANÇA (auditoria da Fase 3): sem --cap-drop
            // ALL, o CapBnd (bounding set) do sandbox herdava o bounding
            // set inteiro do processo que invoca o bwrap — confirmado ao
            // vivo mostrando CapBnd quase completo mesmo com CapEff/CapPrm
            // zerados. --cap-drop ALL zera as 4 (Inh/Prm/Eff/Bnd),
            // confirmado com teste real. Sem isto, um bug de kernel ou um
            // binário com file capability setada poderia reativar
            // capabilities que o bounding set ainda permitia.
            '--cap-drop', 'ALL',
            // Hostname próprio (não o do host) — sem isto, o hostname real
            // do host vazava pra dentro do sandbox (UTS namespace existe,
            // mas por padrão herda o valor atual, não gera um novo).
            '--hostname', `sandbox-${this.id}`.slice(0, 64),
            // CORREÇÃO (auditoria da Fase 3): --tmpfs /tmp genérico vem
            // ANTES de QUALQUER bind específico (não só o da pasta do bot,
            // como estava antes) — se o binário do node (ou qualquer outro
            // caminho bindado depois) morar dentro de /tmp por algum motivo
            // (builds portáteis, ambientes efêmeros), um --tmpfs /tmp
            // posterior o esconderia do mesmo jeito que escondia a pasta do
            // bot antes desta correção.
            '--proc', '/proc',
            '--dev', '/dev',
            '--tmpfs', '/tmp',
            ...buildBaseSystemBindArgs(),
            '--ro-bind', path.dirname(this.command), path.dirname(this.command), // dir do binário (node), sem assumir que mora em /usr
            '--bind', this.folderPath, this.folderPath, // pasta do bot: leitura E escrita
            '--chdir', this.folderPath,
            '--uid', String(this.uid),
            '--gid', String(this.gid),
            '--clearenv',
            // bwrap não tem uma flag pra "entrar" num network namespace
            // pré-existente que a gente configure por fora — só criar um
            // novo (--unshare-net, já coberto por --unshare-all acima) ou
            // usar o do host (--share-net, nunca usado aqui). --block-fd 3
            // faz o bwrap criar os namespaces e PARAR antes de executar o
            // comando real, esperando 1 byte no fd 3 — dá tempo de start()
            // configurar a rede (veth + IP + rota) de fora, via nsenter no
            // PID que entrou de fato no namespace, antes do processo do bot
            // rodar uma linha de código sequer. Ver networkManager.js.
            '--block-fd', '3',
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
        // fd extra (índice 3) pro --block-fd — bwrap espera 1 byte nele
        // antes de executar o comando real (ver comentário em _buildBwrapArgs).
        this.child = spawn('bwrap', bwrapArgs, {
            stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
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

        // Configura a rede ANTES de desbloquear o bwrap (que ainda está
        // parado esperando o --block-fd, sem ter executado uma linha sequer
        // do comando real). Se qualquer passo falhar, derruba tudo — rodar
        // sem a rede prometida (ou pior, deixar o bwrap preso pra sempre
        // esperando o fd) não é uma opção.
        try {
            const innerPid = await findInnerPid(this.child.pid);
            if (!innerPid) {
                throw new Error('não foi possível localizar o processo interno do bwrap (namespaces) a tempo');
            }
            networkManager.attachNetwork(this.network, innerPid);
        } catch (err) {
            this._kill('SIGKILL');
            this.state = 'exited';
            throw new Error(`Não foi possível configurar a rede do sandbox — sandbox encerrado por segurança: ${err.message}`);
        } finally {
            // Desbloqueia o bwrap de qualquer jeito (sucesso ou falha) — se
            // falhou, o processo já foi morto acima, então isto só libera o
            // fd pra não deixar um processo zumbi esperando indefinidamente
            // logo antes de morrer.
            try {
                this.child.stdio[3].write('x');
                this.child.stdio[3].end();
            } catch { /* processo já pode ter morrido */ }
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
     *
     * CORREÇÃO (auditoria da Fase 3 — race condition real): esta função
     * mandava SIGKILL e RETORNAVA na hora, sem confirmar que o processo já
     * tinha morrido de verdade (o evento 'exit' do child_process é
     * assíncrono — o kernel ainda pode levar um instante pra terminar de
     * limpar o processo depois do SIGKILL). destroy() chamava stop() e
     * IMEDIATAMENTE tentava remover o diretório de cgroup — se o processo
     * ainda não tivesse sido totalmente colhido pelo kernel, `cgroup.procs`
     * ainda não estava vazio, e rmdirSync falhava com EBUSY, deixando um
     * diretório de cgroup órfão pra sempre (nada tentava de novo depois).
     * Agora esperamos de verdade o estado virar 'exited' também depois do
     * SIGKILL, com um teto de tempo pra nunca travar indefinidamente.
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

    /**
     * Encerra e libera todos os recursos (cgroup). Depois de destroy(), a
     * instância não pode ser reaproveitada — crie uma nova.
     *
     * CORREÇÃO (auditoria da Fase 3): stop() agora só retorna depois de
     * confirmar 'exited' (ver comentário lá), então na maioria dos casos
     * cgroup.procs já está vazio aqui. Mesmo assim, uma única tentativa de
     * rmdirSync engolida em silêncio deixava um diretório de cgroup órfão
     * pra sempre se algo demorasse um pouco mais (kernel ainda liberando
     * recursos). Agora tenta algumas vezes com um pequeno intervalo antes
     * de desistir, e avisa no console se mesmo assim não conseguir — nunca
     * falha silenciosamente a ponto de ninguém saber que há um cgroup
     * vazando.
     */
    async destroy() {
        await this.stop();
        if (this.network) {
            networkManager.detachNetwork(this.network);
            this.network = null;
        }
        if (this.cgroupDir && fs.existsSync(this.cgroupDir)) {
            const dir = this.cgroupDir;
            let removed = false;
            for (let attempt = 0; attempt < 5 && !removed; attempt++) {
                try {
                    fs.rmdirSync(dir);
                    removed = true;
                } catch {
                    await new Promise((r) => setTimeout(r, 200));
                }
            }
            if (!removed) {
                console.error(`[LinuxSandboxBackend] Não foi possível remover o cgroup ${dir} após destroy() — pode haver processo residual. Verificação manual recomendada.`);
            }
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
            network: this.network ? { hostIp: this.network.hostIp, botIp: this.network.botIp } : null,
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
