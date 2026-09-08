/**
 * GERENCIADOR DE PROCESSOS DOS BOTS HOSPEDADOS
 * Controla start, stop, restart e monitoramento
 *
 * Correções aplicadas:
 * - .env do bot não vaza mais variáveis do processo pai (segurança crítica)
 * - auto-restart não dispara após stop manual (flag intentionalStop)
 * - python3 como fallback de python
 * - logs persistidos em arquivo além da memória
 * - limpeza de processos zumbis no startup (syncStatusOnStartup)
 * - tratamento correto de SIGTERM/SIGKILL no stopBot
 * - getSystemStats com Promise.all para paralelismo e fallback de erro
 */
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const si = require('systeminformation');
const { db, run, get, query } = require('../database/database');
const { decrypt } = require('../utils/crypto');
const { formatBytes, formatUptime } = require('../utils/format');
const { commandExists } = require('../utils/runtime');
const config = require('../../config');
const { addLog } = require('./consoleManager');
const { alertBotCrash } = require('./alertManager');
const { updateHealth, markCrashLoop } = require('./healthManager');
const { decideBackend, createSandbox } = require('./sandbox/SandboxManager');

// ── MAPAS DE ESTADO ────────────────────────────────────────────────────────────
// botId → { process, startTime, logs[] }
const activeProcesses = new Map();
// botId → número de tentativas de restart
const restartAttempts = new Map();
// botIds que foram parados intencionalmente (não devem disparar auto-restart)
const intentionalStop = new Set();

// ── GARANTE QUE PASTAS NECESSÁRIAS EXISTAM ────────────────────────────────────
for (const folder of [config.system.botsFolder, config.system.backupsFolder, config.system.logsFolder]) {
    if (!fs.existsSync(folder)) {
        fs.mkdirSync(folder, { recursive: true });
    }
}

/**
 * Verifica (via /proc, Linux/Android/Termux) se um PID ainda pertence de fato
 * ao bot esperado, comparando o cmdline do processo com o folder_path do bot.
 * Isso evita matar um processo qualquer que tenha reaproveitado o mesmo PID
 * (PIDs são reciclados pelo SO com o tempo).
 */
function findRealOrphanPid(pid, folderPath) {
    try {
        if (!fs.existsSync(`/proc/${pid}/cmdline`)) return false;
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
        return cmdline.includes(folderPath);
    } catch {
        return false; // Sem /proc (ex: não-Linux) ou processo já morreu: não arrisca matar
    }
}

/**
 * Ao iniciar o processo principal, marca todos os bots como offline.
 * Bots podem ter ficado com status 'online' de uma execução anterior
 * que foi encerrada abruptamente (crash, SIGKILL, etc.).
 *
 * CORREÇÃO (lifecycle): antes isto só zerava o status no BANCO, sem checar se
 * o processo do SO daquele PID ainda estava rodando de verdade. Resultado:
 * se o painel caísse sem graceful shutdown, o processo do bot ficava órfão
 * rodando em background, e um novo startBot() para o mesmo bot criava um
 * SEGUNDO processo duplicado (dois bots logados com o mesmo token, ou dois
 * processos brigando pela mesma porta). Agora tentamos localizar e encerrar
 * o processo órfão de verdade antes de liberar o bot para um novo start.
 */
function syncStatusOnStartup() {
    try {
        const staleBots = query("SELECT id, pid, folder_path FROM bots WHERE status = 'online'");
        for (const bot of staleBots) {
            if (bot.pid && findRealOrphanPid(bot.pid, bot.folder_path)) {
                try {
                    process.kill(bot.pid, 'SIGKILL');
                    console.warn(`⚠️ Processo órfão do bot ${bot.id} (PID ${bot.pid}) encontrado e encerrado.`);
                } catch {
                    // Processo já não existe mais (condição de corrida entre a checagem e o kill)
                }
            }
        }
        run("UPDATE bots SET status = 'offline', pid = NULL WHERE status = 'online'");
        console.log('✅ Status dos bots sincronizado com o estado real.');
    } catch (err) {
        console.error('⚠️ Erro ao sincronizar status dos bots:', err.message);
    }
}
// CORREÇÃO CRÍTICA (ordem de boot): esta função ERA chamada aqui mesmo, no
// carregamento do módulo (topo do arquivo, fora de qualquer função). O
// problema: index.js só chama initDatabase() DEPOIS de importar este manager
// (require('./src/managers/processManager') vem antes de initDatabase() no
// index.js) — então, numa instalação nova (banco ainda sem a tabela `bots`),
// syncStatusOnStartup() sempre rodava ANTES da tabela existir e falhava
// silenciosamente com "no such table: bots", logo no primeiro boot. Agora só
// exportamos a função — quem decide QUANDO chamá-la é o index.js, depois de
// initDatabase() já ter rodado (ver comentário lá).

/**
 * Persiste uma linha de log em arquivo (além da memória).
 * Operação best-effort: falhas são silenciosas para não derrubar o processo.
 */
function appendLogToFile(botId, type, text) {
    try {
        const logPath = path.join(config.system.logsFolder, `${botId}.log`);
        const line = `[${new Date().toISOString()}] [${type.toUpperCase()}] ${text}\n`;
        fs.appendFileSync(logPath, line, 'utf-8');
    } catch {
        // Falha silenciosa
    }
}

/**
 * Detecta o comando correto para Python no sistema.
 * Tenta python3 primeiro (padrão em sistemas modernos), depois python.
 */
function detectPythonCommand() {
    for (const cmd of ['python3', 'python']) {
        try {
            execSync(`${cmd} --version`, { stdio: 'ignore' });
            return cmd;
        } catch {
            // Tenta o próximo
        }
    }
    return 'python3'; // Fallback padrão
}

// Cache do comando Python (detectado uma vez)
const PYTHON_CMD = detectPythonCommand();

const os = require('os');

/**
 * CORREÇÃO (feature decorativa): bots.node_version existia no banco e era
 * mostrado na UI, mas NUNCA era usado de verdade — todo bot sempre rodava com
 * o `node` do PATH do sistema, não importa o que o dono tivesse selecionado.
 * Agora detectamos versões instaladas via nvm (se disponível) e usamos a
 * versão pedida de verdade quando ela existe no servidor.
 */
function detectAvailableNodeVersions() {
    const versions = new Map(); // major version (string) -> caminho do binário
    try {
        // CORREÇÃO: só olhava o formato do nvm de Linux/Mac (~/.nvm/versions/node/vX/bin/node).
        // No Windows, o nvm-windows guarda as versões de outro jeito — pasta
        // apontada por %NVM_HOME%, com "node.exe" direto dentro de vX.Y.Z (sem bin/).
        if (process.platform === 'win32') {
            const nvmHome = process.env.NVM_HOME;
            if (nvmHome && fs.existsSync(nvmHome)) {
                for (const dir of fs.readdirSync(nvmHome)) {
                    const m = dir.match(/^v(\d+)\./);
                    if (m) {
                        const binPath = path.join(nvmHome, dir, 'node.exe');
                        if (fs.existsSync(binPath)) versions.set(m[1], binPath);
                    }
                }
            }
        } else {
            const nvmDir = path.join(os.homedir(), '.nvm', 'versions', 'node');
            if (fs.existsSync(nvmDir)) {
                for (const dir of fs.readdirSync(nvmDir)) {
                    const m = dir.match(/^v(\d+)\./);
                    if (m) {
                        const binPath = path.join(nvmDir, dir, 'bin', 'node');
                        if (fs.existsSync(binPath)) versions.set(m[1], binPath);
                    }
                }
            }
        }
    } catch {
        // nvm não instalado ou inacessível — segue só com o node padrão do PATH
    }
    return versions;
}
const AVAILABLE_NODE_VERSIONS = detectAvailableNodeVersions();

function resolveNodeBinary(requestedVersion, botId) {
    const major = requestedVersion ? String(requestedVersion).split('.')[0] : null;
    if (major && AVAILABLE_NODE_VERSIONS.has(major)) {
        return AVAILABLE_NODE_VERSIONS.get(major);
    }
    if (major) {
        addLog(botId, `Node.js v${requestedVersion} solicitado mas não encontrado via nvm neste servidor. Usando a versão padrão do sistema.`, 'stdout');
    }
    return 'node';
}

/**
 * Mesma ideia para Python: procura binários versionados já instalados no PATH
 * (python3.9, python3.11, etc.) em vez de sempre usar o genérico python3.
 */
function detectAvailablePythonVersions() {
    const versions = new Map();
    for (const minor of ['3.8', '3.9', '3.10', '3.11', '3.12', '3.13']) {
        if (commandExists(`python${minor}`)) versions.set(minor, `python${minor}`);
    }
    return versions;
}
const AVAILABLE_PYTHON_VERSIONS = detectAvailablePythonVersions();

function resolvePythonBinary(requestedVersion, botId) {
    if (requestedVersion) {
        for (const [ver, cmd] of AVAILABLE_PYTHON_VERSIONS) {
            if (ver === requestedVersion || ver.startsWith(`${requestedVersion}.`)) return cmd;
        }
        addLog(botId, `Python ${requestedVersion} solicitado mas não encontrado neste servidor. Usando ${PYTHON_CMD} (padrão).`, 'stdout');
    }
    return PYTHON_CMD;
}

// Cache de disponibilidade de 'nice' e 'cpulimit' (detectados uma vez no boot,
// em vez de rodar execSync a cada startBot() — antes isso rodava toda vez).
// CORREÇÃO: usava 'which' direto, que não existe no Windows (é 'where.exe' lá)
// — reaproveita o helper multiplataforma que já existe em utils/runtime.js
// em vez de manter uma segunda cópia (essa aqui estava desatualizada/quebrada).
const NICE_AVAILABLE = commandExists('nice');
const CPULIMIT_AVAILABLE = commandExists('cpulimit');

/**
 * Descobre o limite de RAM (MB) efetivo para um bot: usa o override específico
 * do bot se definido (bots.max_memory), senão cai para o limite do plano do
 * dono (users.max_ram), senão usa o default global do .env.
 */
/**
 * Limite de RAM efetivo do bot, com teto de segurança do HOST.
 * Prioridade: bots.max_memory > users.max_ram (plano) > config default
 * Depois aplica o teto global HOST_MAX_RAM_PER_BOT pra nunca estourar o PC.
 */
function getEffectiveRamLimit(bot) {
    let limit = null;
    if (bot.max_memory) limit = Number(bot.max_memory);
    if (!limit) {
        const owner = get('SELECT max_ram FROM users WHERE id = ?', [bot.creator_id]);
        if (owner && owner.max_ram) limit = Number(owner.max_ram);
    }
    if (!limit) limit = Number(config.security.maxRamPerBot) || 256;

    // Teto absoluto do host (protege o PC / VPS)
    const hostCap = Number(process.env.HOST_MAX_RAM_PER_BOT)
        || Number(config.security.hostMaxRamPerBot)
        || 512;
    limit = Math.min(limit, hostCap);

    // Piso mínimo razoável
    return Math.max(64, limit);
}

/**
 * Descobre o limite de CPU (%) efetivo para um bot, mesma lógica de fallback.
 */
function getEffectiveCpuLimit(bot) {
    let limit = null;
    if (bot.max_cpu_limit) limit = Number(bot.max_cpu_limit);
    if (!limit) {
        const owner = get('SELECT max_cpu FROM users WHERE id = ?', [bot.creator_id]);
        if (owner && owner.max_cpu) limit = Number(owner.max_cpu);
    }
    if (!limit) limit = Number(config.security.maxCpuPerBot) || 30;

    const hostCap = Number(process.env.HOST_MAX_CPU_PER_BOT)
        || Number(config.security.hostMaxCpuPerBot)
        || 50;
    return Math.min(Math.max(5, limit), hostCap);
}

/**
 * Proteção global de RAM do HOST.
 * Soma a RAM reservada pelos bots online + o bot que quer subir.
 * Se passar do limite seguro do sistema, bloqueia o start.
 */
function assertHostRamAvailable(neededMB, excludeBotId = null) {
    const os = require('os');
    const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
    const freeMB = Math.floor(os.freemem() / 1024 / 1024);

    // % máxima da RAM total que os bots podem usar juntos (default 60%)
    const maxPct = Number(process.env.HOST_MAX_RAM_PERCENT)
        || Number(config.security.hostMaxRamPercent)
        || 60;
    const hardCapMB = Math.floor(totalMB * (maxPct / 100));

    // Soma RAM dos bots já online
    let usedByBots = 0;
    for (const [id, entry] of activeProcesses.entries()) {
        if (excludeBotId && id === excludeBotId) continue;
        if (entry.reservedRamMB) {
            usedByBots += entry.reservedRamMB;
            continue;
        }
        // fallback: pega do banco
        const row = get('SELECT max_memory, creator_id FROM bots WHERE id = ?', [id]);
        if (row) usedByBots += getEffectiveRamLimit(row);
        else usedByBots += Number(config.security.maxRamPerBot) || 256;
    }

    const after = usedByBots + neededMB;

    // Também exige que tenha RAM livre real no SO (margem de 15%)
    const freeNeeded = Math.floor(neededMB * 1.15);

    if (after > hardCapMB) {
        throw new Error(
            `RAM do host insuficiente. Bots online reservam ~${usedByBots}MB + este bot ${neededMB}MB = ${after}MB, ` +
            `limite do host é ${hardCapMB}MB (${maxPct}% de ${totalMB}MB). Pare outros bots ou aumente o plano do host.`
        );
    }
    if (freeMB < freeNeeded) {
        throw new Error(
            `Pouca RAM livre no sistema (${freeMB}MB livre, precisa de ~${freeNeeded}MB). ` +
            `Feche programas ou pare alguns bots antes de subir outro.`
        );
    }
    return { usedByBots, hardCapMB, freeMB, totalMB };
}

// Marcadores de caminho que sugerem uma tentativa de ler/escrever algo da
// PLATAFORMA (não do próprio bot) — evidência "dura" pro SecurityEngine
// (um único evento já é CRITICAL, ver SecurityEngine.js). Não é uma lista
// exaustiva, é deliberadamente pequena e explícita: preferimos deixar um
// caso passar como sinal genérico (ainda SUSPICIOUS/HIGH) a arriscar falso
// positivo numa lista ampla demais.
const PLATFORM_SECRET_MARKERS = /\.env\b|hosting\.db|ENCRYPTION_KEY|GITHUB_WEBHOOK_SECRET/i;

/**
 * Interpreta uma linha de log fixa do security_wrapper.js ("🚨 SEGURANÇA: ...")
 * e repassa pro SecurityEngine com o código certo. Lazy require: evita
 * ciclo de carregamento (SecurityEngine -> IncidentResponseManager ->
 * processManager), já que isto só roda em tempo de execução, bem depois de
 * todo mundo já ter terminado de carregar.
 */
function reportSecurityWrapperViolation(botId, text) {
    const { reportSignal } = require('./security/SecurityEngine');

    const pathMatch = text.match(/fora da pasta do bot(?: via link simbólico)?: (.+)/);
    let code = 'wrapper_violation';

    if (/via link simbólico/.test(text)) {
        code = 'symlink_escape_blocked';
        if (pathMatch && PLATFORM_SECRET_MARKERS.test(pathMatch[1])) code = 'platform_secret_path_blocked';
    } else if (pathMatch) {
        code = PLATFORM_SECRET_MARKERS.test(pathMatch[1]) ? 'platform_secret_path_blocked' : 'path_escape_blocked';
    } else if (/módulo '.+' é proibido/.test(text)) {
        code = 'banned_module_blocked';
    } else if (/process\.binding/.test(text)) {
        code = 'banned_binding_blocked';
    }

    reportSignal({
        botId,
        source: 'security_wrapper',
        code,
        // Nunca inclui o texto bruto completo (pode conter o caminho
        // tentado, que já é suficiente contexto sem precisar do log inteiro).
        details: { matchedPath: pathMatch ? pathMatch[1].slice(0, 200) : null },
    });
}

/**
 * Inicia um bot hospedado.
 * @param {string} botId - ID do bot no banco de dados
 * @returns {ChildProcess} Processo iniciado
 */
async function startBot(botId) {
    // OPERAÇÃO PERSISTENTE (readiness gate): se o serviço está BLOCKED
    // (isolamento Linux forte exigido em produção e indisponível, ou
    // diretório essencial não gravável), nenhum bot hospedado pode iniciar
    // — nunca cai silenciosamente pro backend reduzido pra compensar. O bot
    // de controle do Discord continua respondendo normalmente; só isto (e
    // installDependencies()) recusam. Ver src/managers/serviceReadiness.js.
    const { assertProvisioningAllowed } = require('./serviceReadiness');
    assertProvisioningAllowed(`iniciar o bot ${botId}`);

    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) throw new Error('Bot não encontrado');

    if (bot.status === 'online' && activeProcesses.has(botId)) {
        throw new Error('Bot já está online');
    }

    if (bot.suspended) {
        throw new Error(`Este bot está suspenso${bot.suspended_reason ? `: ${bot.suspended_reason}.` : '.'} Entre em contato com o suporte.`);
    }

    // ── Proteção de RAM do HOST (não deixa estourar o PC) ───────────────────
    const neededRam = getEffectiveRamLimit(bot);
    assertHostRamAvailable(neededRam, botId);

    // ── Prepara ambiente e limites ───────────────────────────────────────────
    const ramLimitMB = getEffectiveRamLimit(bot);
    const cpuLimitPct = getEffectiveCpuLimit(bot);
    const token = bot.token ? decrypt(bot.token) : null;
    let envVars = [];
    try {
        envVars = query('SELECT key, value FROM env_variables WHERE bot_id = ?', [botId]) || [];
    } catch (_) {
        envVars = [];
    }

    const folderPath = path.resolve(bot.folder_path);
    const botEnv = {
        // CORREÇÃO: PATH fixo em formato Unix ('/usr/bin:/bin...') quebrava
        // 100% no Windows — o separador é ';' lá, não ':', e o node.exe nem
        // mora nessas pastas (fica em "Program Files\nodejs" ou no AppData).
        // Isso causava exatamente "spawn node ENOENT": o processo filho não
        // achava o binário do node pra rodar o bot. PATH não é segredo (é só
        // uma lista de pastas), então herdar do processo pai é seguro.
        PATH: process.env.PATH || (process.platform === 'win32'
            ? 'C:\\Windows\\System32;C:\\Windows'
            : '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),
        HOME: folderPath,
        NODE_ENV: 'production',
        PORT: String(bot.internal_port || bot.port || ''),
        PYTHONUNBUFFERED: '1',
        PYTHONDONTWRITEBYTECODE: '1',
    };
    if (process.platform === 'win32') {
        // Node no Windows depende de mais algumas variáveis do sistema pra
        // achar DLLs e resolver o próprio binário corretamente.
        if (process.env.SystemRoot) botEnv.SystemRoot = process.env.SystemRoot;
        if (process.env.WINDIR) botEnv.WINDIR = process.env.WINDIR;
        if (process.env.APPDATA) botEnv.APPDATA = process.env.APPDATA;
        if (process.env.TEMP) botEnv.TEMP = process.env.TEMP;
    }
    if (token) botEnv.DISCORD_TOKEN = token;
    
    const blockedEnvKeys = new Set([
        'PATH', 'HOME', 'BOT_TOKEN', 'ENCRYPTION_KEY', 'OWNER_ID', 'CLIENT_ID',
        'GITHUB_WEBHOOK_SECRET', 'GROQ_API_KEY', 'LOG_WEBHOOK_URL',
    ]);
    for (const v of envVars) {
        if (!blockedEnvKeys.has(v.key)) botEnv[v.key] = v.value;
    }

    // Injeção de Blindagem (Security Wrapper) para Node.js
    const securityWrapperPath = path.join(__dirname, '../utils/security_wrapper.js');

    // ── MODO CONTAINER (isolamento real via Docker) ──────────────────────────
    const containerMgr = require('./containerManager');
    if (containerMgr.containersEnabled() && await containerMgr.isDockerAvailable()) {
        const result = await containerMgr.startInContainer(bot, {
            ramMB: ramLimitMB,
            cpuLimit: cpuLimitPct,
            env: botEnv,
        });

        if (result) {
            intentionalStop.delete(botId);
            // Pseudo-process entry para o monitor reconhecer o bot como online
            activeProcesses.set(botId, {
                process: { 
                    pid: 0, 
                    killed: false, 
                    kill: () => containerMgr.stopContainer(botId),
                    once: () => {},
                    on: () => {}
                },
                startTime: Date.now(),
                logs: [],
                container: true,
                containerId: result.containerId,
                containerName: result.name,
                reservedRamMB: neededRam,
            });
            run("UPDATE bots SET status = ?, pid = ?, last_start = datetime('now') WHERE id = ?",
                ['online', 0, botId]);
            addLog(botId, `🐳 Bot iniciado em container Docker (${result.name})`, 'stdout');

            // Monitora saída do container em background
            const watch = setInterval(async () => {
                try {
                    const st = await containerMgr.getContainerStatus(botId);
                    if (!st || st.status !== 'running') {
                        clearInterval(watch);
                        if (!intentionalStop.has(botId) && activeProcesses.has(botId)) {
                            activeProcesses.delete(botId);
                            run('UPDATE bots SET status = ?, pid = NULL WHERE id = ?', ['offline', botId]);
                            updateHealth(botId, 'crash');
                            if (bot.auto_restart) {
                                const attempts = (restartAttempts.get(botId) || 0) + 1;
                                restartAttempts.set(botId, attempts);
                                if (attempts <= config.system.autoRestartMaxAttempts) {
                                    setTimeout(() => startBot(botId).catch(() => {}), config.system.autoRestartDelay);
                                }
                            }
                        }
                    }
                } catch { /* ignore */ }
            }, 10000);
            if (watch.unref) watch.unref();

            return { container: true, name: result.name };
        }
        // CORREÇÃO DE SEGURANÇA: antes, se o Docker estivesse indisponível ou
        // falhasse ao subir o container, o bot caía silenciosamente pra
        // processo local sem isolamento nenhum — quem ligou USE_CONTAINERS=true
        // queria exatamente a proteção que essa degradação silenciosa perdia.
        // Agora: pediu isolamento, não conseguiu isolamento → não inicia.
        addLog(botId, '🚫 USE_CONTAINERS=true mas não foi possível iniciar em container (Docker indisponível ou falhou). Bot NÃO iniciado — sem fallback pro host.', 'stderr');
        throw new Error('Isolamento por container está ativado (USE_CONTAINERS=true) mas não foi possível iniciar o container. Verifique se o Docker está instalado e rodando, ou desative USE_CONTAINERS para rodar como processo local conscientemente.');
    }

    if (!fs.existsSync(folderPath)) {
        throw new Error('Pasta do bot não encontrada');
    }

    // ── PREPARAÇÃO DOS ARGUMENTOS ─────────────────────────────────────────────
    let command = 'nice';
    let args = [];

    // ── LIMITES DE RECURSO (aplicados na criação do processo, não só no watchdog) ──
    // O watchdog em monitorManager.js roda a cada 30s por padrão: um bot com vazamento
    // de memória pode estourar o host bem antes do próximo ciclo de checagem. Aqui
    // aplicamos um teto já na criação do processo como primeira linha de defesa.
    // IMPORTANTE (limitação real): --max-old-space-size limita apenas o heap do V8,
    // não a RSS total do processo (buffers, memória nativa de addons não entram).
    // Não substitui isolamento por container/cgroup, mas reduz bastante a janela
    // de exposição em relação a depender só do watchdog por polling.

    // NOVO: decide qual backend de isolamento este host pode oferecer ANTES
    // de montar os argumentos finais — a decisão afeta o que é injetado
    // (security_wrapper.js e cpulimit/nice só fazem sentido pro backend
    // 'process'; o backend 'linux' usa isolamento de kernel real e cgroup
    // pra limite de CPU, então não precisa de nenhum dos dois). Minecraft
    // (Java) continua fora do SandboxManager por enquanto — ver comentário
    // mais abaixo.
    let sandboxDecision = null;

    // Configuração específica por tipo de aplicação
    if (bot.type === 'minecraft') {
        const javaCmd = bot.java_version ? `java${bot.java_version}` : 'java';
        const ram = bot.max_memory || 2048;
        const jarFile = bot.main_file || 'server.jar';

        // Aceita EULA automaticamente se não existir
        const eulaPath = path.join(folderPath, 'eula.txt');
        if (!fs.existsSync(eulaPath)) fs.writeFileSync(eulaPath, 'eula=true');

        command = javaCmd;
        args = [
            `-Xmx${ram}M`, `-Xms${Math.floor(ram/2)}M`,
            '-jar', jarFile, 'nogui'
        ];
    } else {
        // CORREÇÃO DE SEGURANÇA: esta é a fronteira real de isolamento pra
        // bots Node/Python. Nunca decida isolamento aqui dentro — só
        // SandboxManager.decideBackend() decide, e nunca cai silenciosamente
        // pro modo reduzido no Linux (fail-closed, ver SandboxManager.js).
        sandboxDecision = decideBackend();
        if (!sandboxDecision.name) {
            throw new Error(sandboxDecision.reason);
        }

        const isPython = bot.language === 'python';
        const mainFile = bot.main_file || (isPython ? 'main.py' : 'index.js');
        const mainFilePath = path.join(folderPath, mainFile);

        if (!fs.existsSync(mainFilePath)) {
            throw new Error(`Arquivo principal não encontrado: ${mainFile}`);
        }

        // Escreve .env para Node/Python
        const envContent = Object.entries(botEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
        fs.writeFileSync(path.join(folderPath, '.env'), envContent, { mode: 0o600 });

        // Comando base: node com teto de heap, ou python.
        // Preferência: virtualenv isolado criado pelo dependencyManager (.hosting-python / .venv),
        // depois a versão pedida pelo usuário, depois o runtime padrão do sistema.
        let baseCmd;
        if (isPython) {
            const markerPath = path.join(folderPath, '.hosting-python');
            const venvPython = path.join(folderPath, '.venv', 'bin', 'python');
            const venvPythonWin = path.join(folderPath, '.venv', 'Scripts', 'python.exe');
            if (fs.existsSync(markerPath)) {
                try {
                    const preferred = fs.readFileSync(markerPath, 'utf8').trim();
                    baseCmd = preferred && fs.existsSync(preferred) ? preferred : null;
                } catch { baseCmd = null; }
            }
            if (!baseCmd && fs.existsSync(venvPython)) baseCmd = venvPython;
            if (!baseCmd && fs.existsSync(venvPythonWin)) baseCmd = venvPythonWin;
            if (!baseCmd) baseCmd = resolvePythonBinary(bot.python_version, botId);
        } else {
            baseCmd = resolveNodeBinary(bot.node_version, botId);
        }

        // security_wrapper.js só é injetado no backend 'process' (reduzido)
        // — no backend 'linux', o isolamento de kernel já cobre o que ele
        // tenta cobrir (e melhor: sem os buracos documentados no
        // SECURITY_AUDIT.md), e manter o wrapper ligado bloquearia usos
        // legítimos de child_process (ex: bots de música chamando ffmpeg)
        // que já são seguros dentro do sandbox de kernel.
        const useReducedWrapper = sandboxDecision.name === 'process';
        const baseArgs = isPython
            ? [mainFilePath]
            : [
                `--max-old-space-size=${ramLimitMB}`,
                ...(useReducedWrapper ? ['--require', securityWrapperPath] : []),
                mainFilePath,
            ];

        if (useReducedWrapper) {
            // Monta a cadeia de wrappers disponíveis: cpulimit > nice > direto
            // (só faz sentido no modo reduzido — o backend 'linux' já limita
            // CPU via cgroup cpu.max, mais confiável que nice/cpulimit).
            if (CPULIMIT_AVAILABLE) {
                command = 'cpulimit';
                args = ['-l', String(cpuLimitPct), '--', baseCmd, ...baseArgs];
            } else if (NICE_AVAILABLE) {
                command = 'nice';
                args = ['-n', '15', baseCmd, ...baseArgs];
            } else {
                command = baseCmd;
                args = baseArgs;
            }
        } else {
            command = baseCmd;
            args = baseArgs;
        }
    }

    let proc;
    let sandboxInstance = null;

    if (bot.type === 'minecraft') {
        // Minecraft (Java) ainda não passa pelo SandboxManager — fica de
        // fora desta refatoração de propósito (ver relatório da
        // integração). Continua exatamente como antes: spawn direto.
        proc = spawn(command, args, {
            cwd: folderPath,
            env: botEnv,
            detached: false,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } else {
        sandboxInstance = await createSandbox(sandboxDecision, {
            id: botId,
            folderPath,
            command,
            args,
            env: botEnv,
            limits: {
                memoryMB: ramLimitMB,
                cpuPercent: cpuLimitPct,
                pids: config.security.maxPidsPerBot || 100,
            },
        });
        proc = await sandboxInstance.start();
    }

    // CORREÇÃO: o listener de erro do processo precisa ser registrado JÁ AQUI,
    // logo depois do spawn(). Antes ficava lá embaixo, depois do run() que usa
    // proc.pid — se o spawn falhasse (ex: "spawn node ENOENT" no Windows por
    // PATH errado), o run() já quebrava ANTES de chegar no listener, e o
    // evento 'error' assíncrono do processo disparava sem ninguém ouvindo →
    // Node trata isso como uncaughtException e derruba o painel inteiro.
    proc.on('error', (err) => {
        console.error(`❌ Erro ao iniciar processo do bot ${botId}:`, err.message);
        addLog(botId, `❌ Erro ao iniciar processo: ${err.message}`, 'stderr');
        activeProcesses.delete(botId);
        run('UPDATE bots SET status = ?, pid = NULL WHERE id = ?', ['offline', botId]);
    });

    // Remove da lista de stops intencionais (caso tenha sido parado antes)
    intentionalStop.delete(botId);

    // Registra no mapa de processos ativos (com RAM reservada pro guard do host)
    activeProcesses.set(botId, {
        process: proc,
        sandbox: sandboxInstance,
        startTime: Date.now(),
        logs: [],
        reservedRamMB: neededRam,
    });

    // Atualiza status no banco
    // CORREÇÃO: proc.pid pode vir undefined se o spawn falhar de forma
    // síncrona — bind de undefined quebra o node:sqlite ("Provided value
    // cannot be bound to SQLite parameter"). null é um valor válido pro SQLite.
    run("UPDATE bots SET status = ?, pid = ?, last_start = datetime('now') WHERE id = ?",
        ['online', proc.pid ?? null, botId]);

    // CORREÇÃO CRÍTICA (Crash Loop Protection não funcionava de verdade):
    // antes o contador de tentativas era resetado para 0 aqui, TODA VEZ que
    // o processo era iniciado — inclusive durante as próprias tentativas de
    // auto-restart. Resultado: um bot em loop infinito de crash (crasha em
    // menos de 1 segundo, sempre) nunca acumulava tentativas de verdade,
    // porque o contador voltava a 0 assim que o processo nascia, antes mesmo
    // de saber se ele ia crashar de novo. Na prática, a proteção nunca disparava.
    //
    // Agora só resetamos o contador depois que o processo prova ter rodado de
    // forma ESTÁVEL por um tempo mínimo (STABILITY_THRESHOLD_MS). Um crash que
    // acontece rápido demais soma no contador; um crash depois de rodar
    // estável é tratado como um problema novo, não uma continuação do loop.
    const STABILITY_THRESHOLD_MS = 60000; // 1 minuto rodando = considera "estável"
    const stabilityTimer = setTimeout(() => {
        if (activeProcesses.has(botId)) {
            restartAttempts.delete(botId);
        }
    }, STABILITY_THRESHOLD_MS);
    // Timer não deve impedir o processo Node de encerrar sozinho se for o caso
    if (stabilityTimer.unref) stabilityTimer.unref();

    // ── CAPTURA DE LOGS ───────────────────────────────────────────────────────
    proc.stdout.on('data', (data) => {
        addLog(botId, data, 'stdout');
    });

    proc.stderr.on('data', (data) => {
        addLog(botId, data, 'stderr');
        // KAMIKAZE MODE: security_wrapper.js (backend 'process') loga
        // violações com "console.error" DENTRO do próprio processo do bot —
        // sem isto, essas linhas ficavam só no stderr capturado, invisíveis
        // pra qualquer sistema de resposta automática. Reconhece o prefixo
        // fixo (nunca muda, ver security_wrapper.js) e repassa pro
        // SecurityEngine classificar. Nunca deixa uma falha aqui quebrar a
        // captura normal de logs.
        try {
            const text = data.toString();
            if (text.includes('🚨 SEGURANÇA')) {
                reportSecurityWrapperViolation(botId, text);
            }
        } catch (_) { /* nunca quebra a captura de logs por causa disso */ }
    });

    // ── MONITORAMENTO DE CRASH / AUTO-RESTART ─────────────────────────────────
    proc.on('exit', (code) => {
        // Nenhum timer pode ficar órfão: cancela o timer de estabilidade deste
        // processo assim que ele sai, quer o timer já tenha disparado ou não.
        clearTimeout(stabilityTimer);

        activeProcesses.delete(botId);
        run('UPDATE bots SET status = ?, pid = NULL WHERE id = ?', ['offline', botId]);

        const wasIntentional = intentionalStop.has(botId);
        intentionalStop.delete(botId);
        const willHitCrashLoop = bot.auto_restart && code !== 0 && !wasIntentional &&
            (restartAttempts.get(botId) || 0) + 1 > config.system.autoRestartMaxAttempts;

        // Alerta de crash e atualização de saúde se não foi intencional.
        // Se este exit já vai confirmar um Crash Loop, pulamos o alerta genérico
        // aqui — o alerta específico de crash loop abaixo é mais informativo e
        // evita mandar dois alertas seguidos pro mesmo evento.
        if (!wasIntentional && code !== 0) {
            updateHealth(botId, 'crash');
            if (!willHitCrashLoop) alertBotCrash(botId, code);
        }

        // Auto-restart apenas se: configurado, saída anormal E não foi stop intencional
        if (bot.auto_restart && code !== 0 && !wasIntentional) {
            const attempts = (restartAttempts.get(botId) || 0) + 1;
            restartAttempts.set(botId, attempts);

            if (attempts <= config.system.autoRestartMaxAttempts) {
                console.log(`🔄 Auto-restart do bot ${botId} (tentativa ${attempts}/${config.system.autoRestartMaxAttempts})`);
                setTimeout(() => {
                    startBot(botId).catch((err) => {
                        console.error(`❌ Falha no auto-restart do bot ${botId}:`, err.message);
                    });
                }, config.system.autoRestartDelay);
            } else {
                // CRASH LOOP CONFIRMADO: esgotou as tentativas sem rodar estável
                // nenhuma vez. Para de tentar, desliga auto-restart (senão o
                // próximo start manual reativaria o mesmo ciclo sem fim) e avisa.
                console.warn(`💀 Bot ${botId} entrou em Crash Loop — parando tentativas automáticas.`);
                restartAttempts.delete(botId);
                markCrashLoop(botId);
                run('UPDATE bots SET auto_restart = 0 WHERE id = ?', [botId]);
                alertBotCrash(botId, code, true);

                const { tryDM } = require('../utils/clientRef');
                tryDM(bot.creator_id,
                    `💀 **Seu bot "${bot.name}" entrou em Crash Loop.**\n` +
                    `Ele crashou repetidamente rápido demais e o auto-restart foi desativado automaticamente para não ficar consumindo recursos à toa.\n` +
                    `Verifique os logs (\`Ver Logs\` no painel), corrija o problema, e reative o Auto Restart quando quiser tentar de novo.`
                );
            }
        }
    });

    return proc;
}

/**
 * Para um bot hospedado de forma intencional.
 * Marca como stop intencional ANTES de matar o processo para evitar
 * que o handler de 'exit' dispare o auto-restart.
 * @param {string} botId
 */
function stopBot(botId) {
    // CRÍTICO: marcar como intencional ANTES de matar o processo
    intentionalStop.add(botId);

    const active = activeProcesses.get(botId);

    // Container mode
    if (active?.container) {
        try {
            const { stopContainer } = require('./containerManager');
            // Await stopContainer to ensure it's finished
            stopContainer(botId).catch(err => console.error(`[CONTAINER-STOP] Erro ao parar bot ${botId}:`, err));
        } catch (err) {
            console.error(`[CONTAINER-STOP] Falha fatal ao chamar stopContainer para ${botId}:`, err);
        }
        activeProcesses.delete(botId);
        run('UPDATE bots SET status = ?, pid = NULL WHERE id = ?', ['offline', botId]);
        return true;
    }

    if (!active) {
        run('UPDATE bots SET status = ?, pid = NULL WHERE id = ?', ['offline', botId]);
        return true;
    }

    // CORREÇÃO (integração do SandboxManager): quando o bot foi iniciado via
    // sandbox (backend 'linux' ou 'process'), o encerramento tem que passar
    // pelo destroy() da PRÓPRIA instância — ela sabe esperar o processo
    // realmente morrer antes de tentar liberar o cgroup (ver auditoria do
    // LinuxSandboxBackend). Matar só o processo direto (como no fallback
    // abaixo) deixaria o diretório de cgroup vazando toda vez.
    if (active.sandbox) {
        active.sandbox.destroy()
            .catch((err) => console.error(`[STOP] Erro ao destruir sandbox do bot ${botId}:`, err.message))
            .finally(() => {
                activeProcesses.delete(botId);
                run('UPDATE bots SET status = ?, pid = NULL WHERE id = ?', ['offline', botId]);
            });
        return true;
    }

    // Fallback (bots iniciados sem sandbox — hoje, só Minecraft/Java):
    // mesma lógica de sempre, sem sandbox pra limpar.
    try {
        active.process.kill('SIGTERM');
    } catch {
        // Processo pode já ter terminado
    }

    // Força SIGKILL após 5 segundos se ainda estiver vivo
    const killTimeout = setTimeout(() => {
        try {
            if (!active.process.killed) {
                active.process.kill('SIGKILL');
            }
        } catch {
            // Ignora
        }
    }, 5000);

    // Cancela o timeout se o processo terminar antes
    active.process.once('exit', () => {
        clearTimeout(killTimeout);
        activeProcesses.delete(botId);
        run('UPDATE bots SET status = ?, pid = NULL WHERE id = ?', ['offline', botId]);
    });

    return true;
}

/**
 * Reinicia um bot (stop intencional + start).
 * Espera o processo realmente sair do Map (ou teto de 8s) antes de subir de novo —
 * evita race onde o start cria um segundo processo enquanto o antigo ainda está morrendo.
 */
async function restartBot(botId) {
    stopBot(botId);

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && activeProcesses.has(botId)) {
        await new Promise((r) => setTimeout(r, 200));
    }

    intentionalStop.delete(botId);
    return startBot(botId);
}

/**
 * Obtém logs de um bot (memória em primeiro lugar, arquivo como fallback)
 * @param {string} botId
 * @param {number} lines - Número máximo de linhas a retornar
 */
function getBotLogs(botId, lines = 50) {
    const active = activeProcesses.get(botId);
    if (active) {
        return active.logs.slice(-lines);
    }

    // Fallback: lê do arquivo de log persistido
    const logPath = path.join(config.system.logsFolder, `${botId}.log`);
    if (fs.existsSync(logPath)) {
        try {
            const content = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
            return content.slice(-lines).map(l => ({
                type: l.includes('[ERR]') ? 'err' : 'out',
                text: l,
                time: Date.now(),
            }));
        } catch {
            return [];
        }
    }
    return [];
}

/**
 * Obtém estatísticas do sistema host
 * Usa Promise.all para paralelismo e tem fallback completo em caso de erro
 */
async function getSystemStats() {
    try {
        const [cpu, mem, disk, osInfo] = await Promise.all([
            si.currentLoad(),
            si.mem(),
            si.fsSize(),
            si.osInfo(),
        ]);

        return {
            cpu: cpu.currentLoad.toFixed(1),
            ramUsed: formatBytes(mem.active),
            ramTotal: formatBytes(mem.total),
            ramPercent: ((mem.active / mem.total) * 100).toFixed(1),
            diskUsed: disk[0] ? formatBytes(disk[0].used) : 'N/A',
            diskTotal: disk[0] ? formatBytes(disk[0].size) : 'N/A',
            diskPercent: disk[0] ? (disk[0].use || 0).toFixed(1) : '0',
            os: `${osInfo.platform} ${osInfo.release}`,
        };
    } catch (err) {
        console.error('⚠️ Erro ao coletar estatísticas do sistema:', err.message);
        return {
            cpu: '0.0',
            ramUsed: 'N/A',
            ramTotal: 'N/A',
            ramPercent: '0.0',
            diskUsed: 'N/A',
            diskTotal: 'N/A',
            diskPercent: '0',
            os: 'N/A',
        };
    }
}

/**
 * Obtém estatísticas de um bot específico
 * @param {string} botId
 */
async function getBotStats(botId) {
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return null;

    const active = activeProcesses.get(botId);
    const uptime = active ? Date.now() - active.startTime : (bot.uptime || 0);

    return {
        ...bot,
        uptimeFormatted: formatUptime(Math.floor(uptime / 1000)),
        uptime,
        isOnline: !!active,
    };
}

/**
 * Lista todos os IDs de bots atualmente online
 */
function getOnlineBots() {
    return Array.from(activeProcesses.keys());
}

module.exports = {
    syncStatusOnStartup,
    startBot,
    stopBot,
    restartBot,
    getBotLogs,
    getSystemStats,
    getBotStats,
    getOnlineBots,
    activeProcesses,
};
