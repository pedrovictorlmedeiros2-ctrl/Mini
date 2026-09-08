/**
 * GERENCIADOR DE DEPENDÊNCIAS — v2.0
 * Detecta e instala dependências de bots hospedados com isolamento real.
 *
 * Melhorias vs v1:
 * - Python: cria e usa virtualenv local (.venv) em vez de pip global
 *   (evita PEP 668, poluição do Python do sistema e conflitos entre bots)
 * - Node: prefere npm ci quando há package-lock.json
 * - Timeout, logs e fila com prioridade
 * - Detecta yarn/pnpm se presentes
 * - Marca status de instalação no banco
 */
const { exec, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { addLog } = require('./consoleManager');
const { addToQueue } = require('./queueManager');
const { run } = require('../database/database');

const execAsync = promisify(exec);
const INSTALL_TIMEOUT_MS = 6 * 60 * 1000; // 6 min

function exists(p) {
    try { return fs.existsSync(p); } catch { return false; }
}

/**
 * Garante um virtualenv dentro da pasta do bot e devolve o caminho do pip/python.
 */
async function ensurePythonVenv(botId, folderPath) {
    const venvDir = path.join(folderPath, '.venv');
    const isWin = process.platform === 'win32';
    const pythonBin = isWin
        ? path.join(venvDir, 'Scripts', 'python.exe')
        : path.join(venvDir, 'bin', 'python');
    const pipBin = isWin
        ? path.join(venvDir, 'Scripts', 'pip.exe')
        : path.join(venvDir, 'bin', 'pip');

    if (!exists(pythonBin)) {
        addLog(botId, '🐍 Criando virtualenv isolado (.venv)...', 'stdout');
        try {
            await execAsync('python3 -m venv .venv', {
                cwd: folderPath,
                timeout: 120000,
            });
        } catch (err) {
            // Fallback: alguns sistemas mínimos não têm o módulo venv
            addLog(botId, `⚠️ Falha ao criar venv (${err.message}). Tentando pip com --user.`, 'stderr');
            return { python: 'python3', pip: null, isolated: false };
        }
    }

    if (!exists(pythonBin)) {
        return { python: 'python3', pip: null, isolated: false };
    }

    return { python: pythonBin, pip: pipBin, isolated: true };
}

/**
 * Resolve o gerenciador de pacotes Node (npm / yarn / pnpm).
 */
function resolveNodePackageManager(folderPath) {
    if (exists(path.join(folderPath, 'pnpm-lock.yaml'))) return 'pnpm';
    if (exists(path.join(folderPath, 'yarn.lock'))) return 'yarn';
    return 'npm';
}

/**
 * Instala dependências do bot baseado nos arquivos detectados.
 * @returns {Promise<boolean>}
 */
async function installDependencies(botId, folderPath) {
    // OPERAÇÃO PERSISTENTE (readiness gate): instalar dependências já
    // executa código de terceiros (scripts de install, mesmo com
    // --ignore-scripts nem tudo é coberto — ver achado C4/C6 do
    // SECURITY_AUDIT.md) fora de qualquer sandbox. Em produção BLOCKED
    // (isolamento forte exigido e indisponível), nem esse passo roda —
    // "nenhum provisionamento pode executar" vale também aqui, não só pra
    // startBot(). Ver src/managers/serviceReadiness.js.
    const { assertProvisioningAllowed } = require('./serviceReadiness');
    assertProvisioningAllowed(`instalar dependências do bot ${botId}`);

    return addToQueue(async () => {
        const hasPackageJson = exists(path.join(folderPath, 'package.json'));
        const hasRequirements = exists(path.join(folderPath, 'requirements.txt'));
        const hasPipfile = exists(path.join(folderPath, 'Pipfile'));
        const hasPyproject = exists(path.join(folderPath, 'pyproject.toml'));

        if (!hasPackageJson && !hasRequirements && !hasPipfile && !hasPyproject) {
            addLog(botId, 'Nenhum arquivo de dependências detectado.', 'stdout');
            return true;
        }

        try {
            run("UPDATE bots SET health_status = ? WHERE id = ?", ['installing', botId]);
        } catch { /* coluna pode não existir em schemas antigos */ }

        let success = true;

        // ── Node.js ──────────────────────────────────────────────────────────
        if (hasPackageJson) {
            const pm = resolveNodePackageManager(folderPath);
            const hasLock = exists(path.join(folderPath, 'package-lock.json'));

            let command;
            if (pm === 'npm') {
                // --ignore-scripts: bloqueia postinstall malicioso (supply-chain)
                // Preferimos `npm ci` quando há lock (instalação determinística e mais rápida)
                command = hasLock
                    ? 'npm ci --no-audit --no-fund --ignore-scripts'
                    : 'npm install --no-audit --no-fund --ignore-scripts';
            } else if (pm === 'yarn') {
                command = 'yarn install --frozen-lockfile --ignore-scripts 2>/dev/null || yarn install --ignore-scripts';
            } else {
                command = 'pnpm install --ignore-scripts --frozen-lockfile 2>/dev/null || pnpm install --ignore-scripts';
            }

            addLog(botId, `📦 Node.js detectado. Instalando com ${pm}...`, 'stdout');
            success = (await runInstallCommand(botId, folderPath, command)) && success;

            // CORREÇÃO DE SEGURANÇA (SECURITY_AUDIT.md, achado C4): esta versão
            // chegou a rodar automaticamente `prisma generate` e `npm run
            // build` aqui. Isso reabria execução de código arbitrário do
            // cliente: o script "build" de um package.json pode ser QUALQUER
            // comando de shell, executado via exec() direto no host, sem
            // NENHUM isolamento (o security_wrapper.js só é aplicado na hora
            // de RODAR o bot via spawn(), não durante o install/build). O
            // raciocínio original ("é o schema/script do próprio bot, não de
            // um pacote de terceiro") explica por que não é afetado por
            // --ignore-scripts, mas não muda o fato de ser code execution
            // completo. Removido até existir um mecanismo real de isolamento
            // pro passo de build/deploy (ver SandboxManager, Fase 3+) — bots
            // TypeScript/Prisma precisam ser buildados fora da plataforma e
            // ter o "Arquivo principal" apontado pro JS já compilado.
        }

        // ── Python ───────────────────────────────────────────────────────────
        if (hasRequirements || hasPipfile || hasPyproject) {
            const { python, pip, isolated } = await ensurePythonVenv(botId, folderPath);

            // CORREÇÃO DE SEGURANÇA: sem container, `pip install` de um pacote
            // de terceiros pode executar código arbitrário do autor do pacote
            // durante o build (setup.py), diferente do `npm install
            // --ignore-scripts`, que bloqueia isso pro lado Node. --only-binary=:all:
            // recusa instalar qualquer pacote que não tenha wheel pronto —
            // ou seja, nunca compila/roda setup.py de terceiros. Pacotes sem
            // wheel pra essa plataforma vão falhar a instalação (mais seguro
            // que instalar sem essa trava). Dá pra desligar via env var pra
            // quem sabe o que tá fazendo e precisa de um pacote sem wheel.
            const allowSdistBuild = String(process.env.PYTHON_ALLOW_SDIST_BUILD || '').toLowerCase() === 'true';
            const safetyFlag = allowSdistBuild ? '' : ' --only-binary=:all:';

            if (hasRequirements) {
                const pipCmd = isolated && pip
                    ? `"${pip}" install --no-cache-dir${safetyFlag} -r requirements.txt`
                    : `python3 -m pip install --no-cache-dir --user${safetyFlag} -r requirements.txt`;

                addLog(
                    botId,
                    isolated
                        ? '📦 Python: instalando requirements no virtualenv isolado...'
                        : '📦 Python: instalando requirements (modo --user)...',
                    'stdout'
                );
                success = (await runInstallCommand(botId, folderPath, pipCmd)) && success;
            } else if (hasPyproject) {
                // -e . instala o próprio código do bot (não é pacote de terceiros),
                // então --only-binary não se aplica aqui — o setup.py que roda
                // é do próprio bot que já vai ser executado de qualquer forma.
                const pipCmd = isolated && pip
                    ? `"${pip}" install --no-cache-dir -e .`
                    : 'python3 -m pip install --no-cache-dir --user -e .';
                addLog(botId, '📦 Python: instalando pyproject.toml...', 'stdout');
                success = (await runInstallCommand(botId, folderPath, pipCmd)) && success;
            }

            // Guarda o interpretador preferido para o processManager usar depois
            if (isolated && python) {
                try {
                    const marker = path.join(folderPath, '.hosting-python');
                    fs.writeFileSync(marker, python, 'utf8');
                } catch { /* best-effort */ }
            }
        }

        try {
            run("UPDATE bots SET health_status = ? WHERE id = ?", [success ? 'healthy' : 'degraded', botId]);
        } catch { /* ignore */ }

        return success;
    }, `Instalação de dependências do bot ${botId}`, { priority: 'high', timeoutMs: INSTALL_TIMEOUT_MS + 30000 });
}

function runInstallCommand(botId, folderPath, command) {
    return new Promise((resolve) => {
        // CORREÇÃO DE SEGURANÇA: antes herdava `...process.env` inteiro, o que
        // dava ao instalador (npm/pip rodando código do CLIENTE, potencialmente
        // malicioso) acesso a BOT_TOKEN, ENCRYPTION_KEY e demais segredos do
        // próprio Atlantic Host. Agora montamos um ambiente mínimo: só o
        // necessário pra achar os binários (PATH) e o instalador funcionar.
        // Cache isolado por bot evita também um bot ler/poluir o cache de outro.
        const npmCacheDir = path.join(folderPath, '.npm-cache');
        const pipCacheDir = path.join(folderPath, '.pip-cache');
        const installEnv = {
            PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            HOME: folderPath,
            LANG: process.env.LANG || 'C.UTF-8',
            TEMP: os.tmpdir(),
            TMPDIR: os.tmpdir(),
            NPM_CONFIG_UPDATE_NOTIFIER: 'false',
            NPM_CONFIG_CACHE: npmCacheDir,
            PIP_CACHE_DIR: pipCacheDir,
            CI: 'true',
            PYTHONUNBUFFERED: '1',
            PYTHONDONTWRITEBYTECODE: '1',
        };

        const proc = exec(command, {
            cwd: folderPath,
            timeout: INSTALL_TIMEOUT_MS,
            env: installEnv,
            maxBuffer: 4 * 1024 * 1024,
        });

        proc.stdout?.on('data', (data) => addLog(botId, data, 'stdout'));
        proc.stderr?.on('data', (data) => addLog(botId, data, 'stderr'));

        proc.on('close', (code) => {
            if (code === 0) {
                addLog(botId, '✅ Dependências instaladas com sucesso!', 'stdout');
                resolve(true);
            } else {
                addLog(botId, `❌ Falha ao instalar dependências (código: ${code})`, 'stderr');
                resolve(false);
            }
        });

        proc.on('error', (err) => {
            addLog(botId, `❌ Erro ao executar instalador: ${err.message}`, 'stderr');
            resolve(false);
        });
    });
}

module.exports = { installDependencies };
