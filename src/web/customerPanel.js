/**
 * PAINEL DO CLIENTE — login via Discord OAuth2, cada usuário vê e gerencia
 * SÓ os próprios bots (dono ou colaborador com permissão), com console ao
 * vivo, gerenciador de arquivos e um mini editor de código no navegador.
 *
 * Diferente do painel administrativo (src/web/panelServer.js, token único
 * compartilhado, vê TODOS os bots): aqui a identidade vem do Discord OAuth2
 * e toda ação passa por canManageBot() — o mesmo chokepoint de autorização
 * já usado pelos comandos slash do bot (src/managers/userManager.js).
 *
 * Porta e ativação são independentes do painel admin (CUSTOMER_PANEL_ENABLED
 * / CUSTOMER_PANEL_PORT) — os dois podem rodar juntos, cada um na sua porta.
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { get, query, run } = require('../database/database');
const { registerUser, canManageBot } = require('../managers/userManager');
const { createSessionToken, verifySessionToken, COOKIE_NAME, SESSION_TTL_MS } = require('../utils/panelSession');
const { checkRateLimit, formatRetryAfter } = require('../utils/rateLimiter');
const fileManager = require('../managers/fileManager');
const consoleManager = require('../managers/consoleManager');
const { logAction, logSecurityEvent } = require('../managers/logManager');

let server = null;

// ── Config / helpers do OAuth2 ──────────────────────────────────────────────

const DISCORD_API = 'https://discord.com/api/v10';

function oauthConfig() {
    const clientId = process.env.CLIENT_ID;
    const clientSecret = process.env.DISCORD_CLIENT_SECRET;
    const redirectUri = process.env.DISCORD_REDIRECT_URI;
    return { clientId, clientSecret, redirectUri };
}

function isOAuthConfigured() {
    const { clientId, clientSecret, redirectUri } = oauthConfig();
    return Boolean(clientId && clientSecret && redirectUri);
}

// ── Cookies (sem dependência nova — parsing/assinatura manuais) ────────────

function parseCookies(req) {
    const header = req.headers.cookie;
    const out = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (key) out[key] = decodeURIComponent(value);
    }
    return out;
}

function setCookie(res, name, value, { maxAgeMs, httpOnly = true } = {}) {
    const isProd = process.env.NODE_ENV === 'production';
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
    if (httpOnly) parts.push('HttpOnly');
    if (isProd) parts.push('Secure');
    if (maxAgeMs != null) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
    const existing = res.getHeader('Set-Cookie');
    const next = existing ? [].concat(existing, parts.join('; ')) : parts.join('; ');
    res.setHeader('Set-Cookie', next);
}

function clearCookie(res, name) {
    setCookie(res, name, '', { maxAgeMs: 0 });
}

// ── Autenticação ─────────────────────────────────────────────────────────

function requireSession(req, res, next) {
    const cookies = parseCookies(req);
    const payload = verifySessionToken(cookies[COOKIE_NAME]);
    if (!payload) {
        return res.status(401).json({ error: 'not_authenticated', message: 'Faça login com o Discord.' });
    }
    const user = get('SELECT * FROM users WHERE id = ?', [payload.sub]);
    if (!user) {
        return res.status(401).json({ error: 'not_authenticated', message: 'Usuário não encontrado.' });
    }
    req.currentUser = user;
    next();
}

// Carrega o bot do :id da rota e confere posse/permissão — chokepoint único
// de autorização multi-tenant: não encontrado OU sem permissão = 404 igual
// (nunca confirma pra quem não tem acesso que aquele bot existe).
function loadBot(requiredPermission = 'view') {
    return (req, res, next) => {
        const bot = get('SELECT * FROM bots WHERE id = ?', [req.params.id]);
        if (!bot) return res.status(404).json({ error: 'not_found' });
        if (!canManageBot(req.currentUser.id, bot, requiredPermission)) {
            logSecurityEvent(req.currentUser.id, 'ACCESS_DENIED', `Tentou acessar bot ${bot.id} (${requiredPermission}) via painel sem permissão`);
            return res.status(404).json({ error: 'not_found' });
        }
        req.bot = bot;
        next();
    };
}

function safeQueryPath(req) {
    return typeof req.query.path === 'string' ? req.query.path : '';
}

// Rate limit genérico por usuário pra operações de escrita do painel (arquivo,
// pasta, variável de ambiente) — sem isso, nada impedia um usuário autenticado
// de escrever/apagar arquivos em loop, sobrecarregando I/O de disco à toa.
function rateLimited(bucket, max, windowMs) {
    return (req, res, next) => {
        const limit = checkRateLimit(`${bucket}:${req.currentUser.id}`, max, windowMs);
        if (!limit.allowed) {
            return res.status(429).json({ error: 'rate_limited', message: `Muitas operações. Aguarde ${formatRetryAfter(limit.retryAfterMs)}.` });
        }
        next();
    };
}

// Limite de conexões SSE simultâneas por usuário: o painel do cliente roda
// no MESMO processo Node do bot Discord e de todos os outros bots hospedados
// (não é isolado por request). Sem limite, um único usuário autenticado
// (dono legítimo de um bot) conseguiria abrir centenas/milhares de streams
// de console simultâneos e degradar o processo inteiro pra todo mundo —
// um DoS de tenant único afetando os demais.
const MAX_SSE_PER_USER = 5;
const openSseByUser = new Map();

function acquireSseSlot(userId) {
    const current = openSseByUser.get(userId) || 0;
    if (current >= MAX_SSE_PER_USER) return false;
    openSseByUser.set(userId, current + 1);
    return true;
}

function releaseSseSlot(userId) {
    const current = openSseByUser.get(userId) || 0;
    if (current <= 1) openSseByUser.delete(userId);
    else openSseByUser.set(userId, current - 1);
}

// ── App ──────────────────────────────────────────────────────────────────

function startCustomerPanel(port = Number(process.env.CUSTOMER_PANEL_PORT) || 3090) {
    if (String(process.env.CUSTOMER_PANEL_ENABLED || '').toLowerCase() !== 'true' &&
        process.env.CUSTOMER_PANEL_ENABLED !== '1') {
        console.log('[PANEL] Painel do cliente desabilitado (CUSTOMER_PANEL_ENABLED!=true).');
        return null;
    }
    if (!isOAuthConfigured()) {
        console.error('[PANEL] Painel do cliente NÃO iniciado: CLIENT_ID, DISCORD_CLIENT_SECRET e DISCORD_REDIRECT_URI precisam estar configurados (Discord Developer Portal → OAuth2).');
        return null;
    }

    const app = express();
    app.disable('x-powered-by');
    app.set('query parser', 'simple'); // mitigação de CVE moderado em `qs`, ver proxyManager.js
    app.use(express.json({ limit: '512kb' }));
    app.use(express.static(path.join(__dirname, 'customer-public')));

    // ── OAuth2 ────────────────────────────────────────────────────────────

    app.get('/auth/login', (req, res) => {
        const state = crypto.randomBytes(24).toString('hex');
        setCookie(res, 'oauth_state', state, { maxAgeMs: 10 * 60 * 1000 });
        const { clientId, redirectUri } = oauthConfig();
        const url = new URL(`${DISCORD_API}/oauth2/authorize`);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('scope', 'identify');
        url.searchParams.set('state', state);
        res.redirect(url.toString());
    });

    app.get('/auth/callback', async (req, res) => {
        try {
            const limit = checkRateLimit(`oauth_callback:${req.ip}`, 20, 10 * 60 * 1000);
            if (!limit.allowed) {
                return res.status(429).send(`Muitas tentativas de login. Tente novamente em ${formatRetryAfter(limit.retryAfterMs)}.`);
            }

            const { code, state } = req.query;
            const cookies = parseCookies(req);
            // Proteção CSRF do fluxo OAuth: o "state" devolvido pelo Discord tem
            // que bater com o que geramos e guardamos num cookie de curta duração
            // no passo /auth/login — sem isso, um atacante poderia induzir a
            // vítima a completar um login com uma sessão que o atacante controla.
            if (!code || !state || !cookies.oauth_state || state !== cookies.oauth_state) {
                return res.status(400).send('Login inválido ou expirado. Tente novamente.');
            }
            clearCookie(res, 'oauth_state');

            const { clientId, clientSecret, redirectUri } = oauthConfig();
            const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    grant_type: 'authorization_code',
                    code: String(code),
                    redirect_uri: redirectUri,
                }),
            });
            if (!tokenRes.ok) {
                console.error('[PANEL] Falha na troca de código OAuth2:', tokenRes.status);
                return res.status(502).send('Não foi possível confirmar o login com o Discord. Tente novamente.');
            }
            const tokenData = await tokenRes.json();

            const userRes = await fetch(`${DISCORD_API}/users/@me`, {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            if (!userRes.ok) {
                return res.status(502).send('Não foi possível obter seus dados do Discord. Tente novamente.');
            }
            const discordUser = await userRes.json();

            const user = registerUser({
                id: discordUser.id,
                username: discordUser.global_name || discordUser.username,
                discriminator: discordUser.discriminator || '0',
                avatar: discordUser.avatar,
            });

            const sessionToken = createSessionToken(user.id);
            setCookie(res, COOKIE_NAME, sessionToken, { maxAgeMs: SESSION_TTL_MS });
            logAction(null, user.id, 'PANEL_LOGIN', 'Login no painel via Discord OAuth2');
            res.redirect('/');
        } catch (err) {
            console.error('[PANEL] Erro no callback OAuth2:', err.message);
            res.status(500).send('Erro interno ao processar o login. Tente novamente.');
        }
    });

    app.post('/auth/logout', requireSession, (req, res) => {
        clearCookie(res, COOKIE_NAME);
        res.json({ ok: true });
    });

    app.get('/api/me', requireSession, (req, res) => {
        const u = req.currentUser;
        res.json({
            id: u.id,
            username: u.username,
            avatar: u.avatar,
            role: u.role,
            plan_name: u.plan_name,
            plan_expiry: u.plan_expiry,
            max_bots: u.max_bots,
            max_cpu: u.max_cpu,
            max_ram: u.max_ram,
        });
    });

    // ── Bots (lista + detalhe) ──────────────────────────────────────────────

    app.get('/api/bots', requireSession, (req, res) => {
        const bots = query(
            `SELECT b.id, b.code, b.name, b.type, b.status, b.language, b.cpu_usage, b.ram_usage,
                    b.suspended, b.health_status, b.created_at,
                    CASE WHEN b.creator_id = ? THEN 1 ELSE 0 END AS is_owner
             FROM bots b
             LEFT JOIN bot_collaborators c ON c.bot_id = b.id AND c.user_id = ?
             WHERE b.creator_id = ? OR c.user_id IS NOT NULL
             ORDER BY b.created_at DESC`,
            [req.currentUser.id, req.currentUser.id, req.currentUser.id]
        );
        res.json({ bots });
    });

    app.get('/api/bots/:id', requireSession, loadBot('view'), (req, res) => {
        const bot = { ...req.bot };
        delete bot.token; // nunca expõe o token do bot hospedado pro navegador
        res.json({ bot });
    });

    app.get('/api/bots/:id/stats', requireSession, loadBot('view'), async (req, res) => {
        try {
            const { getBotStats } = require('../managers/processManager');
            const stats = await getBotStats(req.bot.id);
            res.json({ stats: stats || null });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Ações (start/stop/restart) ──────────────────────────────────────────

    app.post('/api/bots/:id/start', requireSession, loadBot('start'), async (req, res) => {
        try {
            if (req.bot.suspended) return res.status(403).json({ error: 'suspended', message: 'Bot suspenso.' });
            const limit = checkRateLimit(`panel_action:${req.currentUser.id}`, 20, 60 * 1000);
            if (!limit.allowed) return res.status(429).json({ error: 'rate_limited', message: `Aguarde ${formatRetryAfter(limit.retryAfterMs)}.` });
            const { startBot } = require('../managers/processManager');
            await startBot(req.bot.id);
            logAction(req.bot.id, req.currentUser.id, 'PANEL_START', 'Iniciado via painel do cliente');
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.post('/api/bots/:id/stop', requireSession, loadBot('stop'), async (req, res) => {
        try {
            const limit = checkRateLimit(`panel_action:${req.currentUser.id}`, 20, 60 * 1000);
            if (!limit.allowed) return res.status(429).json({ error: 'rate_limited', message: `Aguarde ${formatRetryAfter(limit.retryAfterMs)}.` });
            const { stopBot } = require('../managers/processManager');
            stopBot(req.bot.id);
            logAction(req.bot.id, req.currentUser.id, 'PANEL_STOP', 'Parado via painel do cliente');
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.post('/api/bots/:id/restart', requireSession, loadBot('start'), async (req, res) => {
        try {
            if (req.bot.suspended) return res.status(403).json({ error: 'suspended', message: 'Bot suspenso.' });
            const limit = checkRateLimit(`panel_action:${req.currentUser.id}`, 20, 60 * 1000);
            if (!limit.allowed) return res.status(429).json({ error: 'rate_limited', message: `Aguarde ${formatRetryAfter(limit.retryAfterMs)}.` });
            const { restartBot } = require('../managers/processManager');
            await restartBot(req.bot.id);
            logAction(req.bot.id, req.currentUser.id, 'PANEL_RESTART', 'Reiniciado via painel do cliente');
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ── Console (histórico + ao vivo via SSE) ───────────────────────────────

    app.get('/api/bots/:id/logs', requireSession, loadBot('view'), (req, res) => {
        res.json({ logs: consoleManager.getRecentLogs(req.bot.id) });
    });

    app.get('/api/bots/:id/console/stream', requireSession, loadBot('view'), (req, res) => {
        if (!acquireSseSlot(req.currentUser.id)) {
            return res.status(429).json({ error: 'rate_limited', message: `Muitas conexões de console abertas ao mesmo tempo (máximo ${MAX_SSE_PER_USER}). Feche alguma aba e tente de novo.` });
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);

        const botId = req.bot.id;
        const onLine = (payload) => {
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };
        consoleManager.consoleEvents.on(`line:${botId}`, onLine);

        // Heartbeat pra manter proxies/load balancers de não fecharem a conexão
        // por inatividade, e pra o cliente detectar queda de conexão.
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

        req.on('close', () => {
            clearInterval(heartbeat);
            consoleManager.consoleEvents.off(`line:${botId}`, onLine);
            releaseSseSlot(req.currentUser.id);
        });
    });

    // ── Arquivos (mini editor) ───────────────────────────────────────────────

    app.get('/api/bots/:id/files', requireSession, loadBot('view'), (req, res) => {
        try {
            const entries = fileManager.listFiles(req.bot.folder_path, safeQueryPath(req));
            res.json({ entries });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    const MAX_INLINE_FILE_BYTES = 2 * 1024 * 1024;

    app.get('/api/bots/:id/files/content', requireSession, loadBot('view'), (req, res) => {
        try {
            const filePath = safeQueryPath(req);
            if (!filePath) return res.status(400).json({ error: 'path obrigatório' });
            // CORREÇÃO DE SEGURANÇA (achado durante o próprio desenvolvimento
            // desta rota): a checagem de tamanho aqui fazia fs.statSync(path.resolve(...))
            // direto, sem passar pela validação de safeResolve — reabria o
            // mesmo path traversal que o fileManager existe pra bloquear (e
            // ainda vazava fragmento de caminho do host na mensagem de erro
            // quando o arquivo "traversal" não existia). statFile() usa a
            // mesma validação segura de readFile/writeFile.
            const stat = fileManager.statFile(req.bot.folder_path, filePath);
            if (!stat) return res.status(404).json({ error: 'not_found' });
            if (stat.size > MAX_INLINE_FILE_BYTES) {
                return res.status(413).json({ error: 'file_too_large', message: 'Arquivo grande demais para editar aqui (limite 2MB).' });
            }
            const content = fileManager.readFile(req.bot.folder_path, filePath);
            if (content === null) return res.status(404).json({ error: 'not_found' });
            res.json({ path: filePath, content });
        } catch (err) {
            res.status(400).json({ error: 'Caminho inválido.' });
        }
    });

    app.put('/api/bots/:id/files/content', requireSession, loadBot('files'), rateLimited('panel_file_write', 60, 60 * 1000), (req, res) => {
        try {
            const { path: filePath, content } = req.body || {};
            if (typeof filePath !== 'string' || typeof content !== 'string') {
                return res.status(400).json({ error: 'path e content (string) são obrigatórios' });
            }
            if (Buffer.byteLength(content, 'utf8') > MAX_INLINE_FILE_BYTES) {
                return res.status(413).json({ error: 'file_too_large' });
            }
            fileManager.writeFile(req.bot.folder_path, filePath, content);
            logAction(req.bot.id, req.currentUser.id, 'PANEL_FILE_WRITE', filePath);
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.post('/api/bots/:id/files/folder', requireSession, loadBot('files'), rateLimited('panel_file_write', 60, 60 * 1000), (req, res) => {
        try {
            const { path: folderPath } = req.body || {};
            if (typeof folderPath !== 'string' || !folderPath) return res.status(400).json({ error: 'path obrigatório' });
            fileManager.createFolder(req.bot.folder_path, folderPath);
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.delete('/api/bots/:id/files', requireSession, loadBot('files'), rateLimited('panel_file_write', 60, 60 * 1000), (req, res) => {
        try {
            const { path: targetPath } = req.body || {};
            if (typeof targetPath !== 'string' || !targetPath) return res.status(400).json({ error: 'path obrigatório' });
            fileManager.deleteItem(req.bot.folder_path, targetPath);
            logAction(req.bot.id, req.currentUser.id, 'PANEL_FILE_DELETE', targetPath);
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    app.post('/api/bots/:id/files/rename', requireSession, loadBot('files'), rateLimited('panel_file_write', 60, 60 * 1000), (req, res) => {
        try {
            const { path: oldPath, newName } = req.body || {};
            if (typeof oldPath !== 'string' || typeof newName !== 'string' || !oldPath || !newName) {
                return res.status(400).json({ error: 'path e newName são obrigatórios' });
            }
            fileManager.renameItem(req.bot.folder_path, oldPath, newName);
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    // ── Variáveis de ambiente ────────────────────────────────────────────────

    const SECRET_KEY_HINTS = ['token', 'secret', 'password', 'senha', 'key', 'chave'];
    function maskIfSecret(key, value) {
        const lower = key.toLowerCase();
        if (!SECRET_KEY_HINTS.some((h) => lower.includes(h))) return value;
        if (!value || value.length <= 4) return '****';
        return `${value.slice(0, 2)}${'*'.repeat(Math.min(value.length - 4, 20))}${value.slice(-2)}`;
    }

    app.get('/api/bots/:id/env', requireSession, loadBot('view'), (req, res) => {
        const rows = query('SELECT key, value FROM env_variables WHERE bot_id = ? ORDER BY key', [req.bot.id]);
        res.json({ env: rows.map((r) => ({ key: r.key, value: maskIfSecret(r.key, r.value) })) });
    });

    const ENV_KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

    app.put('/api/bots/:id/env', requireSession, loadBot('files'), rateLimited('panel_env_write', 30, 60 * 1000), (req, res) => {
        const { key, value } = req.body || {};
        if (typeof key !== 'string' || !ENV_KEY_REGEX.test(key) || key.length > 100) {
            return res.status(400).json({ error: 'invalid_key', message: 'Nome de variável inválido.' });
        }
        if (typeof value !== 'string' || value.length > 8192) {
            return res.status(400).json({ error: 'invalid_value' });
        }
        run(
            `INSERT INTO env_variables (bot_id, key, value) VALUES (?, ?, ?)
             ON CONFLICT(bot_id, key) DO UPDATE SET value = excluded.value`,
            [req.bot.id, key, value]
        );
        logAction(req.bot.id, req.currentUser.id, 'PANEL_ENV_SET', key);
        res.json({ ok: true });
    });

    app.delete('/api/bots/:id/env/:key', requireSession, loadBot('files'), rateLimited('panel_env_write', 30, 60 * 1000), (req, res) => {
        run('DELETE FROM env_variables WHERE bot_id = ? AND key = ?', [req.bot.id, req.params.key]);
        logAction(req.bot.id, req.currentUser.id, 'PANEL_ENV_DELETE', req.params.key);
        res.json({ ok: true });
    });

    // SPA fallback: qualquer rota não-API devolve o index (roteamento no cliente)
    app.get(/^(?!\/api|\/auth).*/, (req, res) => {
        res.sendFile(path.join(__dirname, 'customer-public', 'index.html'));
    });

    const bind = process.env.CUSTOMER_PANEL_HOST || '0.0.0.0';
    server = app.listen(port, bind, () => {
        console.log(`🌐 Painel do cliente em http://${bind}:${port} (login via Discord OAuth2)`);
    });
    return server;
}

function stopCustomerPanel() {
    if (server) {
        server.close();
        server = null;
    }
}

module.exports = { startCustomerPanel, stopCustomerPanel, parseCookies, setCookie, clearCookie };
