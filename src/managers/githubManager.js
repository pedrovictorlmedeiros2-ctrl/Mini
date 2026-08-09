/**
 * GERENCIADOR DE GITHUB (WEBHOOKS)
 * Permite deploy automático via GitHub Webhooks
 */
const express = require('express');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { get, run } = require('../database/database');
const { restartBot } = require('./processManager');
const { addLog } = require('./consoleManager');
const { installDependencies } = require('./dependencyManager');
const { checkRateLimit } = require('../utils/rateLimiter');
const { detectLanguageAndMainFile, flattenSingleSubfolder } = require('../utils/languageDetector');

const app = express();

// ── VALIDAÇÃO DE ENTRADA (essencial: repoUrl/branch/hash vêm do usuário) ──────
// CORREÇÃO/PRINCÍPIO DE SEGURANÇA: todas as funções abaixo chamam `git` via
// execFile com argumentos em ARRAY, nunca via exec()/template string. execFile
// não passa por um shell, então mesmo que repoUrl/branch contenham caracteres
// como `;`, `$()`, backticks etc., eles são tratados como um único argumento
// literal para o git — nunca como comando adicional. A validação abaixo é uma
// segunda camada (rejeita cedo, com mensagem clara) além dessa proteção estrutural.
const GITHUB_REPO_REGEX = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/;
const BRANCH_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const COMMIT_HASH_REGEX = /^[0-9a-f]{7,40}$/i;

function validateRepoUrl(url) {
    if (typeof url !== 'string' || !GITHUB_REPO_REGEX.test(url)) {
        throw new Error('URL de repositório inválida. Use o formato https://github.com/usuario/repositorio');
    }
}
function validateBranchName(branch) {
    if (typeof branch !== 'string' || !BRANCH_NAME_REGEX.test(branch) || branch.includes('..')) {
        throw new Error('Nome de branch inválido.');
    }
}
function validateCommitHash(hash) {
    if (typeof hash !== 'string' || !COMMIT_HASH_REGEX.test(hash)) {
        throw new Error('Hash de commit inválido.');
    }
}

/**
 * Clona um repositório público do GitHub para a pasta de um bot (usado no
 * fluxo "Adicionar Bot via GitHub"). Detecta linguagem/arquivo principal
 * igual ao fluxo de upload via ZIP.
 */
async function cloneRepo(repoUrl, branch, destFolder) {
    validateRepoUrl(repoUrl);
    validateBranchName(branch);

    if (fs.existsSync(destFolder) && fs.readdirSync(destFolder).length > 0) {
        throw new Error('Pasta de destino já contém arquivos.');
    }
    fs.mkdirSync(destFolder, { recursive: true });

    try {
        // --depth 1: só o commit mais recente (deploy, não precisa do histórico
        // completo) — clona bem mais rápido e usa bem menos disco.
        await execFileAsync('git', ['clone', '--branch', branch, '--single-branch', '--depth', '1', repoUrl, destFolder]);
    } catch (err) {
        fs.rmSync(destFolder, { recursive: true, force: true });
        throw new Error(`Falha ao clonar repositório: ${err.message}`);
    }

    let { language, mainFile, searchRoot } = detectLanguageAndMainFile(destFolder);
    let detectedByAI = false;

    // Mesmo fallback de IA usado no deploy via ZIP: se a heurística normal não
    // achar nada, pergunta pra Groq antes de desistir.
    if (!mainFile) {
        const { detectLanguageWithAI } = require('./diagnosticManager');
        const aiResult = await detectLanguageWithAI(searchRoot);
        if (aiResult.success) {
            language = aiResult.language;
            mainFile = aiResult.mainFile;
            detectedByAI = true;
        } else {
            fs.rmSync(destFolder, { recursive: true, force: true });
            throw new Error(`Nenhum arquivo principal encontrado no repositório, e a detecção por IA também não conseguiu: ${aiResult.reason}`);
        }
    }
    flattenSingleSubfolder(destFolder, searchRoot);

    return { language, mainFile, detectedByAI };
}

/**
 * Busca e aplica as atualizações mais recentes da branch configurada do bot.
 * --ff-only: só avança se for possível um fast-forward (sem merge). Se o
 * histórico local divergiu (ex: alguém editou arquivos manualmente e isso
 * de alguma forma virou um commit local), falha com erro claro em vez de
 * tentar um merge automático que poderia dar errado silenciosamente.
 */
async function pullLatest(folderPath) {
    const { stdout } = await execFileAsync('git', ['pull', '--ff-only'], { cwd: folderPath });
    return stdout;
}

/**
 * Troca a branch ativa do bot e já puxa a versão mais recente dela.
 */
async function switchBranch(folderPath, branch) {
    validateBranchName(branch);
    await execFileAsync('git', ['fetch', 'origin', branch], { cwd: folderPath });
    await execFileAsync('git', ['checkout', branch], { cwd: folderPath });
    await execFileAsync('git', ['pull', '--ff-only'], { cwd: folderPath });
}

/**
 * Retorna os últimos commits (mais recente primeiro) — usado para montar o
 * menu de seleção de rollback.
 */
async function getCommitHistory(folderPath, limit = 10) {
    const { stdout } = await execFileAsync(
        'git',
        ['log', `-${Number(limit) || 10}`, '--pretty=format:%H|%an|%ad|%s', '--date=short'],
        { cwd: folderPath }
    );
    return stdout.split('\n').filter(Boolean).map(line => {
        const [hash, author, date, ...msgParts] = line.split('|');
        return { hash, author, date, message: msgParts.join('|') };
    });
}

/**
 * Reverte a pasta do bot para o estado exato de um commit específico.
 * ATENÇÃO: isso é destrutivo — qualquer alteração feita depois desse commit
 * (incluindo edições manuais via Gerenciador de Arquivos que não foram
 * commitadas) é perdida. A UI precisa deixar isso claro antes de confirmar.
 */
async function rollbackToCommit(folderPath, commitHash) {
    validateCommitHash(commitHash);
    // Confirma que o hash existe de fato no histórico antes do reset — evita
    // um "git reset --hard" para um hash qualquer que não pertence ao repo.
    await execFileAsync('git', ['cat-file', '-e', commitHash], { cwd: folderPath }).catch(() => {
        throw new Error('Commit não encontrado no histórico deste bot.');
    });
    await execFileAsync('git', ['reset', '--hard', commitHash], { cwd: folderPath });
}

/**
 * Retorna o hash do commit atual (HEAD) — útil para mostrar "versão atual".
 */
async function getCurrentCommit(folderPath) {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: folderPath });
        return stdout.trim();
    } catch {
        return null;
    }
}

// Middleware para capturar o rawBody necessário para validação da assinatura.
// CORREÇÃO: sem limite de tamanho explícito, um payload gigante enviado por
// qualquer um na internet (este endpoint é público) consumiria memória/CPU
// processando JSON antes mesmo de chegarmos a validar a assinatura.
app.use(express.json({
    limit: '1mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// CORREÇÃO: este endpoint fica exposto publicamente na internet (é assim que
// o GitHub consegue chamar), mas não tinha NENHUM rate limit — um atacante
// podia bombardear /github-webhook com requisições (custam HMAC + parsing
// JSON a cada uma) sem qualquer limite, um vetor de negação de serviço barato.
app.use((req, res, next) => {
    const limit = checkRateLimit(`webhook_ip:${req.ip}`, 30, 60 * 1000);
    if (!limit.allowed) {
        return res.status(429).send('Too Many Requests');
    }
    next();
});

/**
 * Valida a assinatura do GitHub
 *
 * CORREÇÃO: se GITHUB_WEBHOOK_SECRET não estiver definido (é opcional no
 * .env.example), crypto.createHmac(secret=undefined) ou timingSafeEqual com
 * buffers de tamanho diferente lançavam exceção não tratada dentro da rota.
 * Agora tratamos os dois casos explicitamente e nunca deixamos a validação
 * quebrar sem rejeitar a requisição.
 *
 * ATENÇÃO (limitação de arquitetura, documentada — não é um "bug" pontual):
 * o segredo é ÚNICO e global para todos os bots hospedados. Qualquer pessoa
 * que tenha esse segredo (ex: um cliente que também configurou deploy via
 * GitHub) pode, em tese, forjar um push falso e disparar git pull + restart
 * em QUALQUER bot cujo github_repo ela souber (o repo pode ser público).
 * Uma correção completa exigiria um secret por bot (coluna nova + fluxo de
 * configuração), o que é uma mudança de escopo maior — sinalizando aqui para
 * priorização futura.
 */
function verifySignature(req) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const signature = req.headers['x-hub-signature-256'];
    if (!secret || !signature) return false;

    try {
        const hmac = crypto.createHmac('sha256', secret);
        const digest = 'sha256=' + hmac.update(req.rawBody).digest('hex');
        const sigBuf = Buffer.from(signature);
        const digestBuf = Buffer.from(digest);
        if (sigBuf.length !== digestBuf.length) return false;
        return crypto.timingSafeEqual(sigBuf, digestBuf);
    } catch {
        return false;
    }
}

/**
 * Endpoint para receber Webhooks do GitHub
 * Configuração no GitHub: Payload URL = http://seu-ip:porta/github-webhook
 */
app.post('/github-webhook', async (req, res) => {
    // 1. Validar assinatura do GitHub
    if (!verifySignature(req)) {
        console.warn('⚠️ GitHub: Assinatura de webhook inválida!');
        return res.status(401).send('Invalid signature');
    }

    const payload = req.body;
    
    // Verifica se é um evento de push
    if (!payload.repository || !payload.ref) {
        return res.status(400).send('Invalid payload');
    }

    const repoUrl = payload.repository.clone_url;
    const branch = payload.ref.replace('refs/heads/', '');

    // Busca bot associado a este repositório no banco
    // Para isso, precisamos de uma coluna 'github_repo' na tabela bots
    const bot = get('SELECT * FROM bots WHERE github_repo = ? AND github_branch = ?', [repoUrl, branch]);

    if (!bot) {
        return res.status(404).send('Bot not found for this repository');
    }

    addLog(bot.id, `🚀 GitHub: Detectado push na branch ${branch}. Iniciando auto-deploy...`, 'stdout');

    const folderPath = bot.folder_path;

    // CORREÇÃO: este handler duplicava a lógica de atualização usando exec('git
    // pull') direto — sem --ff-only (podia tentar um merge automático e travar
    // esperando um editor de texto que não existe num processo em background,
    // já que não há TTY) e sem os mesmos cuidados (checagem de before/after,
    // deferral de erros) da função pullLatest() já usada pelo botão manual
    // "Atualizar" no painel. Agora reaproveitamos a mesma função testada.
    try {
        const before = await getCurrentCommit(folderPath);
        await pullLatest(folderPath);
        const after = await getCurrentCommit(folderPath);

        if (before === after) {
            addLog(bot.id, `ℹ️ GitHub: Push recebido mas nenhuma mudança nova aplicável em ${branch}.`, 'stdout');
            return res.status(200).send('OK (no changes)');
        }

        addLog(bot.id, `✅ GitHub: Arquivos atualizados (${before?.substring(0, 7)} → ${after?.substring(0, 7)}).`, 'stdout');

        // Reinstala dependências e reinicia
        await installDependencies(bot.id, folderPath);
        await restartBot(bot.id);

        addLog(bot.id, `🔄 GitHub: Bot reiniciado com sucesso após deploy.`, 'stdout');
        res.status(200).send('OK');
    } catch (err) {
        addLog(bot.id, `❌ GitHub: Erro no auto-deploy: ${err.message}`, 'stderr');
        res.status(500).send('Auto-deploy failed');
    }
});

/**
 * Inicia o servidor de Webhooks
 */
function startWebhookServer(port = 3000) {
    if (!process.env.GITHUB_WEBHOOK_SECRET) {
        console.warn('⚠️ GITHUB_WEBHOOK_SECRET não definido: o endpoint /github-webhook vai rejeitar todas as requisições até que seja configurado.');
    }
    app.listen(port, () => {
        console.log(`🌐 Servidor de Webhooks GitHub rodando na porta ${port}`);
    });
}

module.exports = {
    startWebhookServer,
    cloneRepo,
    pullLatest,
    switchBranch,
    getCommitHistory,
    rollbackToCommit,
    getCurrentCommit,
    validateBranchName,
};
