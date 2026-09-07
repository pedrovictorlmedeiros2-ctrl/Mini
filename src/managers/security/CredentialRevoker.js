/**
 * CREDENTIAL REVOKER (Kamikaze Mode)
 *
 * Revoga o que dá pra revogar de credenciais de UM bot comprometido, sem
 * mexer em nada de outros bots.
 *
 * Honestidade sobre o limite real: o token do Discord só é INVALIDADO de
 * verdade pelo próprio Discord, quando o dono regenera no Developer Portal
 * — a plataforma não controla isso. O que este módulo faz é garantir que a
 * plataforma NUNCA reinicie o bot automaticamente com um token que pode já
 * estar exposto: zera a cópia local (`bots.token`), o que faz o próximo
 * `startBot()` falhar por falta de token — comportamento esperado e
 * seguro, não um bug (ver RESTARTING no IncidentResponseManager).
 */
const { run, query } = require('../../database/database');
const { encrypt } = require('../../utils/crypto');

/**
 * @param {object} bot
 * @returns {{ envVarsWiped: number, tokenRevoked: boolean, envSnapshotEncrypted: string|null }}
 */
function revoke(bot) {
    // 1) Snapshot criptografado das env vars antes de apagar — nunca é
    // perda de dado silenciosa, mesmo que a wipe seja permanente.
    const envRows = query('SELECT key, value FROM env_variables WHERE bot_id = ?', [bot.id]) || [];
    const envSnapshotEncrypted = envRows.length ? encrypt(JSON.stringify(envRows)) : null;

    run('DELETE FROM env_variables WHERE bot_id = ?', [bot.id]);

    // 2) Zera o token local — nunca reinicia automaticamente com um token
    // que pode já estar comprometido. O Discord em si só é invalidado pelo
    // dono (Developer Portal) — isso a plataforma não controla, e a DM
    // final deixa isso explícito.
    run(
        "UPDATE bots SET token = NULL, token_revoked_at = datetime('now') WHERE id = ?",
        [bot.id]
    );

    return {
        envVarsWiped: envRows.length,
        tokenRevoked: true,
        envSnapshotEncrypted,
    };
}

module.exports = { revoke };
