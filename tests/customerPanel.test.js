const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-customer-panel.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;
process.env.PANEL_SESSION_SECRET = 'test-panel-session-secret-1234567890';
process.env.CUSTOMER_PANEL_ENABLED = 'true';
process.env.CLIENT_ID = '999999999999999999';
process.env.DISCORD_CLIENT_SECRET = 'test-only-not-a-real-secret';
process.env.DISCORD_REDIRECT_URI = 'http://localhost/auth/callback';

const { initDatabase, run } = require('../src/database/database');
initDatabase();

const { createSessionToken } = require('../src/utils/panelSession');
const { startCustomerPanel, stopCustomerPanel } = require('../src/web/customerPanel');

// Dois usuários e um bot de laboratório — nada real, só pra este teste.
const EVE_ID = '1111111111111111111';
const MALLORY_ID = '2222222222222222222';
run(`INSERT INTO users (id, username, role) VALUES (?, 'lab-eve', 'client')`, [EVE_ID]);
run(`INSERT INTO users (id, username, role) VALUES (?, 'lab-mallory', 'client')`, [MALLORY_ID]);

const botFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-panel-test-'));
fs.writeFileSync(path.join(botFolder, 'index.js'), "console.log('oi')");
run(
    `INSERT INTO bots (id, code, name, creator_id, folder_path, status, language)
     VALUES ('bot-1', 'labbot', 'Lab Bot', ?, ?, 'offline', 'javascript')`,
    [EVE_ID, botFolder]
);

const eveToken = createSessionToken(EVE_ID);
const malloryToken = createSessionToken(MALLORY_ID);

let server;
let baseUrl;

test.before(async () => {
    server = startCustomerPanel(0);
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    stopCustomerPanel();
});

function req(method, urlPath, { token, body } = {}) {
    return new Promise((resolve, reject) => {
        const headers = {};
        if (token) headers.Cookie = `atlantic_session=${token}`;
        let payload;
        if (body !== undefined) {
            payload = JSON.stringify(body);
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(payload);
        }
        const request = http.request(`${baseUrl}${urlPath}`, { method, headers }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch { json = data; }
                resolve({ status: res.statusCode, body: json });
            });
        });
        request.on('error', reject);
        if (payload) request.write(payload);
        request.end();
    });
}

test('sem cookie de sessão, rota protegida retorna 401', async () => {
    const res = await req('GET', '/api/me');
    assert.strictEqual(res.status, 401);
});

test('cookie de sessão válido autentica e devolve o usuário correto', async () => {
    const res = await req('GET', '/api/me', { token: eveToken });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.id, EVE_ID);
});

test('cookie adulterado/inválido é rejeitado', async () => {
    const res = await req('GET', '/api/me', { token: 'lixo.adulterado' });
    assert.strictEqual(res.status, 401);
});

test('dona do bot consegue acessar; quem não é dona nem colaboradora recebe 404 (nunca 403)', async () => {
    const own = await req('GET', '/api/bots/bot-1', { token: eveToken });
    assert.strictEqual(own.status, 200);

    const attacker = await req('GET', '/api/bots/bot-1', { token: malloryToken });
    assert.strictEqual(attacker.status, 404, 'IDOR: usuário sem relação com o bot não pode nem confirmar que ele existe');
});

test('varredura de IDOR: nenhuma rota de bot vaza dado ou permite ação pra quem não tem acesso', async () => {
    const routes = [
        ['GET', '/api/bots/bot-1/stats'],
        ['GET', '/api/bots/bot-1/logs'],
        ['GET', '/api/bots/bot-1/files'],
        ['GET', '/api/bots/bot-1/files/content?path=index.js'],
        ['PUT', '/api/bots/bot-1/files/content', { path: 'index.js', content: 'pwned' }],
        ['DELETE', '/api/bots/bot-1/files', { path: 'index.js' }],
        ['POST', '/api/bots/bot-1/files/folder', { path: 'x' }],
        ['POST', '/api/bots/bot-1/files/rename', { path: 'index.js', newName: 'x.js' }],
        ['GET', '/api/bots/bot-1/env'],
        ['PUT', '/api/bots/bot-1/env', { key: 'X', value: 'y' }],
        ['DELETE', '/api/bots/bot-1/env/X'],
        ['POST', '/api/bots/bot-1/start'],
        ['POST', '/api/bots/bot-1/stop'],
        ['POST', '/api/bots/bot-1/restart'],
    ];
    for (const [method, url, body] of routes) {
        const res = await req(method, url, { token: malloryToken, body });
        assert.strictEqual(res.status, 404, `${method} ${url} deveria ser 404 pra quem não tem acesso ao bot, veio ${res.status}`);
    }
});

test('path traversal clássico é bloqueado mesmo pra dona do bot', async () => {
    const res = await req('GET', '/api/bots/bot-1/files/content?path=' + encodeURIComponent('../../../../etc/passwd'), { token: eveToken });
    assert.notStrictEqual(res.status, 200);
    assert.ok(!JSON.stringify(res.body).toLowerCase().includes('root:'), 'não pode ter conteúdo de /etc/passwd na resposta');
});

test('escape via link simbólico dentro da pasta do bot é bloqueado, mesmo pra dona', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-panel-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'não deveria ser legível');
    fs.symlinkSync(outside, path.join(botFolder, 'escape'));

    const res = await req('GET', '/api/bots/bot-1/files/content?path=' + encodeURIComponent('escape/secret.txt'), { token: eveToken });
    assert.notStrictEqual(res.status, 200);
    assert.ok(!JSON.stringify(res.body).includes('não deveria ser legível'));
});

test('variável de ambiente com nome parecido com secret vem mascarada na listagem', async () => {
    await req('PUT', '/api/bots/bot-1/env', { token: eveToken, body: { key: 'DISCORD_TOKEN', value: 'sk-real-secret-value-12345' } });
    const res = await req('GET', '/api/bots/bot-1/env', { token: eveToken });
    const entry = res.body.env.find((e) => e.key === 'DISCORD_TOKEN');
    assert.ok(entry);
    assert.ok(!entry.value.includes('real-secret-value'), 'valor completo do secret não pode aparecer na listagem');
});

test('colaborador só ganha as permissões explicitamente concedidas (sem "files" não edita arquivos)', async () => {
    run(`INSERT INTO bot_collaborators (bot_id, user_id, permissions) VALUES ('bot-1', ?, 'view,start,stop')`, [MALLORY_ID]);

    const view = await req('GET', '/api/bots/bot-1', { token: malloryToken });
    assert.strictEqual(view.status, 200, 'colaborador com "view" deve conseguir ver o bot');

    const write = await req('PUT', '/api/bots/bot-1/files/content', { token: malloryToken, body: { path: 'index.js', content: 'x' } });
    assert.strictEqual(write.status, 404, 'colaborador sem "files" não pode escrever arquivos');
});

test('console SSE tem limite de conexões simultâneas por usuário (protege o processo compartilhado)', async () => {
    // O painel roda no mesmo processo Node do bot Discord e de todo o resto —
    // sem limite, um usuário sozinho poderia abrir conexões SSE ilimitadas e
    // degradar o processo pra todo mundo. Confirma que a 6ª conexão do mesmo
    // usuário é rejeitada com 429, sem derrubar as 5 anteriores.
    const sockets = [];
    const openStream = () => new Promise((resolve, reject) => {
        const request = http.request(`${baseUrl}/api/bots/bot-1/console/stream`, {
            method: 'GET',
            headers: { Cookie: `atlantic_session=${eveToken}` },
        }, (res) => {
            resolve(res.statusCode);
        });
        request.on('error', reject);
        request.end();
        sockets.push(request);
    });

    try {
        const statuses = [];
        for (let i = 0; i < 6; i++) {
            statuses.push(await openStream());
        }
        assert.strictEqual(statuses.filter((s) => s === 200).length, 5, 'só as primeiras 5 conexões simultâneas devem abrir');
        assert.strictEqual(statuses[5], 429, 'a 6ª conexão simultânea do mesmo usuário deve ser rejeitada');
    } finally {
        for (const s of sockets) s.destroy();
        // dá um tick pro servidor processar o 'close' e liberar os slots antes do próximo teste
        await new Promise((r) => setTimeout(r, 50));
    }
});
