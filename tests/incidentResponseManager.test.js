const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-incidentResponseManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, query, get } = require('../src/database/database');
initDatabase();

const config = require('../config');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-incident-test-'));
config.system.quarantineFolder = path.join(tmpRoot, 'quarantine');
config.system.backupsFolder = path.join(tmpRoot, 'backups');

// Stub do client do Discord: captura toda DM/embed enviado, sem precisar de
// rede ou de um bot Discord de verdade.
const clientRef = require('../src/utils/clientRef');
const sentDMs = []; // { userId, payload }
clientRef.setClient({
    isReady: () => true,
    users: {
        fetch: async (userId) => ({
            send: async (payload) => {
                sentDMs.push({ userId, payload });
                return true;
            },
        }),
    },
});

const { createBackup } = require('../src/managers/backupManager');
const { handleCriticalIncident } = require('../src/managers/security/IncidentResponseManager');

let counter = 0;
function makeBotWithFolder(label) {
    counter += 1;
    const botId = `irtest-${label}-${counter}`;
    const userId = `${botId}-owner`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    const folderPath = path.join(tmpRoot, 'bots', botId);
    fs.mkdirSync(folderPath, { recursive: true });
    fs.writeFileSync(path.join(folderPath, 'index.js'), `console.log('safe-${botId}')`);
    run(
        "INSERT INTO bots (id, code, name, creator_id, folder_path, token) VALUES (?, ?, ?, ?, ?, ?)",
        [botId, botId, `Bot ${label}`, userId, folderPath, `v2:fake-encrypted-token-${botId}`]
    );
    return botId;
}

function dmTextFor(botId) {
    return sentDMs
        .filter((d) => d.userId === `${botId}-owner`)
        .map((d) => (typeof d.payload === 'string' ? d.payload : JSON.stringify(d.payload)))
        .join('\n---\n');
}

test('fluxo completo CRITICAL: quarentena o comprometido, restaura o snapshot seguro, revoga credenciais, não reinicia sem token', async () => {
    const botId = makeBotWithFolder('full-flow');
    const folderPath = get('SELECT folder_path FROM bots WHERE id = ?', [botId]).folder_path;

    // Snapshot seguro (equivalente ao #17/#18 do pedido original) — tirado
    // ANTES de qualquer coisa suspeita, com o conteúdo legítimo do bot.
    await createBackup(botId, 'manual');

    // Env var sensível — usada depois pra confirmar que NUNCA vaza na DM.
    run("INSERT INTO env_variables (bot_id, key, value) VALUES (?, ?, ?)", [botId, 'SECRET_API_KEY', 'SUPER_SECRET_VALUE_123']);

    // Simula o comprometimento: o "current" (equivalente ao #19) diverge do
    // snapshot seguro — nunca virou backup, é só o estado ao vivo da pasta.
    fs.writeFileSync(path.join(folderPath, 'malware.js'), 'exfiltrate_everything()');

    const evidence = { source: 'test', code: 'platform_secret_path_blocked', details: { path: '../../.env' }, rule: 'hard_evidence', evidence: [] };
    await handleCriticalIncident(botId, evidence);

    // ── Quarentena preservou o estado COMPROMETIDO (com malware.js) ──────
    const entry = get('SELECT * FROM quarantine_entries WHERE bot_id = ?', [botId]);
    assert.ok(entry, 'deveria existir uma entrada de quarentena');
    assert.ok(fs.existsSync(path.join(entry.quarantine_path, 'malware.js')), 'a quarentena deveria conter o estado comprometido (com o arquivo malicioso)');

    // ── Workspace restaurado a partir do snapshot seguro (sem o malware) ──
    assert.ok(fs.existsSync(folderPath), 'a pasta do bot deveria existir de novo, restaurada');
    assert.equal(fs.existsSync(path.join(folderPath, 'malware.js')), false, 'o arquivo malicioso não deveria estar no workspace restaurado');
    assert.equal(fs.readFileSync(path.join(folderPath, 'index.js'), 'utf8'), `console.log('safe-${botId}')`);

    // ── Credenciais revogadas ──────────────────────────────────────────────
    const envRows = query('SELECT * FROM env_variables WHERE bot_id = ?', [botId]);
    assert.equal(envRows.length, 0, 'env vars deveriam ter sido apagadas');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    assert.equal(bot.token, null, 'token deveria ter sido zerado');
    assert.ok(bot.token_revoked_at);

    // ── Não reiniciou sem token — permanece suspenso com motivo claro ─────
    assert.equal(bot.suspended, 1);
    assert.match(bot.suspended_reason, /incidente/i);

    // ── Incidente registrado corretamente ─────────────────────────────────
    const incident = get('SELECT * FROM incidents WHERE bot_id = ? ORDER BY id DESC LIMIT 1', [botId]);
    assert.equal(incident.status, 'resolved_partial', 'não reiniciou (sem token) — deveria ser resolved_partial, não resolved');
    assert.equal(incident.severity, 'CRITICAL');
    assert.ok(incident.snapshot_used_id);
    assert.ok(incident.quarantine_entry_id);

    // ── DM: linguagem correta, sem vazar segredos ─────────────────────────
    const dmText = dmTextFor(botId);
    assert.match(dmText, /comportamento potencialmente malicioso/i);
    assert.match(dmText, new RegExp(String(incident.id)));
    assert.doesNotMatch(dmText, /SUPER_SECRET_VALUE_123/, 'a DM nunca deveria conter o valor de uma env var');
    assert.doesNotMatch(dmText, /exfiltrate_everything/, 'a DM nunca deveria conter trecho de código do arquivo malicioso');
    assert.doesNotMatch(dmText, /v2:fake-encrypted-token/, 'a DM nunca deveria conter o token (nem cifrado)');

    // ── Audit log tem o rastro completo do incidente ──────────────────────
    const auditRows = query("SELECT * FROM audit_log WHERE details LIKE ?", [`%${incident.id}%`]);
    const events = auditRows.map((r) => r.action);
    for (const expected of ['kamikaze:containing', 'kamikaze:quarantining', 'kamikaze:locating_snapshot', 'kamikaze:restoring', 'kamikaze:credential_revoking', 'kamikaze:restarting', 'kamikaze:notifying']) {
        assert.ok(events.includes(expected), `esperava o evento de auditoria '${expected}'`);
    }
});

test('ISOLAMENTO: um incidente CRITICAL num bot nunca afeta outro bot (pasta, backups, env vars intactos)', async () => {
    const botA = makeBotWithFolder('tenantA-2');
    const botB = makeBotWithFolder('tenantB-2');

    const folderA = get('SELECT folder_path FROM bots WHERE id = ?', [botA]).folder_path;
    const folderB = get('SELECT folder_path FROM bots WHERE id = ?', [botB]).folder_path;

    await createBackup(botA, 'manual');
    await createBackup(botB, 'manual');
    run("INSERT INTO env_variables (bot_id, key, value) VALUES (?, ?, ?)", [botB, 'B_SECRET', 'valor-do-tenant-b']);

    const beforeBContent = fs.readFileSync(path.join(folderB, 'index.js'), 'utf8');
    const beforeBBackupsCount = query('SELECT * FROM backups WHERE bot_id = ?', [botB]).length;

    await handleCriticalIncident(botA, { source: 'test', code: 'platform_secret_path_blocked', details: {}, rule: 'hard_evidence', evidence: [] });

    assert.equal(fs.existsSync(folderB), true, 'pasta do bot B não deveria ter sido tocada');
    assert.equal(fs.readFileSync(path.join(folderB, 'index.js'), 'utf8'), beforeBContent);
    assert.equal(query('SELECT * FROM backups WHERE bot_id = ?', [botB]).length, beforeBBackupsCount);
    assert.equal(query('SELECT * FROM env_variables WHERE bot_id = ?', [botB]).length, 1, 'env vars do bot B não deveriam ter sido apagadas');

    const botBRow = get('SELECT * FROM bots WHERE id = ?', [botB]);
    assert.equal(botBRow.suspended, 0, 'bot B não deveria ter sido suspenso por um incidente do bot A');
    assert.notEqual(botBRow.token, null, 'token do bot B não deveria ter sido tocado');
});

test('FAIL-SAFE: sem nenhum snapshot seguro, o bot permanece em quarentena/suspenso — nunca inventa uma restauração', async () => {
    const botId = makeBotWithFolder('no-safe-snapshot');
    // Nenhum createBackup() chamado — o bot não tem NENHUM backup.

    await handleCriticalIncident(botId, { source: 'test', code: 'platform_secret_path_blocked', details: {}, rule: 'hard_evidence', evidence: [] });

    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    assert.equal(bot.suspended, 1);

    const incident = get('SELECT * FROM incidents WHERE bot_id = ? ORDER BY id DESC LIMIT 1', [botId]);
    assert.equal(incident.status, 'failed_safe');
    assert.equal(incident.snapshot_used_id, null);

    // A quarentena do estado comprometido ainda deveria ter acontecido —
    // fail-safe não significa "não fez nada", significa "não restaurou às cegas".
    const entry = get('SELECT * FROM quarantine_entries WHERE bot_id = ?', [botId]);
    assert.ok(entry, 'o workspace deveria ter sido preservado em quarentena mesmo sem snapshot pra restaurar');
});

test('CONCORRÊNCIA: dois sinais CRITICAL quase simultâneos pro MESMO bot resultam em um único incidente processado', async () => {
    const botId = makeBotWithFolder('concurrent');
    await createBackup(botId, 'manual');

    await Promise.all([
        handleCriticalIncident(botId, { source: 'test', code: 'platform_secret_path_blocked', details: { run: 1 } }),
        handleCriticalIncident(botId, { source: 'test', code: 'platform_secret_path_blocked', details: { run: 2 } }),
    ]);

    const incidents = query('SELECT * FROM incidents WHERE bot_id = ?', [botId]);
    assert.equal(incidents.length, 1, 'duas chamadas quase simultâneas deveriam resultar em UM único incidente, não dois');
});
