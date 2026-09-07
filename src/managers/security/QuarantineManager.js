/**
 * QUARANTINE MANAGER (Kamikaze Mode)
 *
 * Isola o workspace de UM bot comprometido, sem apagar nada. A pasta viva
 * do bot é movida (rename atômico, mesmo filesystem) pra uma árvore
 * dedicada e separada (`config.system.quarantineFolder`), nunca dentro de
 * `./bots` ou `./backups` — pra nunca ser varrida por engano por uma
 * limpeza/listagem que assume que só bots ativos moram ali.
 *
 * Isto NUNCA apaga a pasta original — só move e registra. A purga (se um
 * dia existir) é uma ação manual de admin, fora do escopo desta entrega
 * (ver `retention_until`/`purged` no schema de `quarantine_entries`).
 */
const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const { run, get } = require('../../database/database');

/**
 * Move a pasta do bot pra quarentena e marca o bot como suspenso (bloqueia
 * qualquer startBot() concorrente, inclusive auto-restart de crash loop já
 * em voo — reaproveita a checagem que já existe em processManager.js).
 *
 * @param {object} bot - linha da tabela bots (já lida do banco)
 * @param {number} incidentId
 * @returns {{ quarantineEntryId: number, quarantinePath: string } | { quarantineEntryId: null, quarantinePath: null }}
 *   retorna quarantinePath null se o bot não tinha pasta (ex: já tinha sido
 *   removida por outro motivo) — não é um erro, só não há o que quarentenar.
 */
function quarantine(bot, incidentId) {
    // CRÍTICO: suspender é a PRIMEIRA escrita, antes de qualquer outra
    // coisa — qualquer startBot() concorrente (clique manual, timer de
    // auto-restart) esbarra nesta checagem que já existe hoje
    // (processManager.js, startBot() -> "if (bot.suspended) throw").
    run(
        "UPDATE bots SET suspended = 1, suspended_reason = ? WHERE id = ?",
        [`Incidente de segurança #${incidentId} — ambiente em quarentena para investigação.`, bot.id]
    );

    const originalPath = path.resolve(bot.folder_path);
    if (!fs.existsSync(originalPath)) {
        return { quarantineEntryId: null, quarantinePath: null };
    }

    const quarantineRoot = path.resolve(config.system.quarantineFolder);
    if (!fs.existsSync(quarantineRoot)) {
        fs.mkdirSync(quarantineRoot, { recursive: true });
    }

    const botQuarantineDir = path.join(quarantineRoot, bot.id);
    if (!fs.existsSync(botQuarantineDir)) {
        fs.mkdirSync(botQuarantineDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantinePath = path.join(botQuarantineDir, `incident-${incidentId}-${timestamp}`);

    // Rename atômico (mesmo filesystem) — não é uma cópia. Se falhar (ex.:
    // disco cheio, permissão, ou quarantineFolder configurado num mount
    // diferente), propaga o erro pro chamador decidir o estado seguro
    // (FAILED_SAFE no IncidentResponseManager) — nunca tenta "meio mover".
    fs.renameSync(originalPath, quarantinePath);

    const sizeBytes = folderSizeBytes(quarantinePath);

    const retentionDays = config.security.kamikaze.quarantineRetentionDays;
    const retentionUntil = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();

    const result = run(
        `INSERT INTO quarantine_entries
            (incident_id, bot_id, original_folder_path, quarantine_path, size_bytes, retention_until)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [incidentId, bot.id, originalPath, quarantinePath, sizeBytes, retentionUntil]
    );

    return { quarantineEntryId: result.lastInsertRowid, quarantinePath };
}

function folderSizeBytes(dir) {
    let total = 0;
    try {
        const stack = [dir];
        while (stack.length) {
            const current = stack.pop();
            for (const name of fs.readdirSync(current)) {
                const full = path.join(current, name);
                const st = fs.lstatSync(full);
                if (st.isSymbolicLink()) continue; // nunca segue link ao medir tamanho
                if (st.isDirectory()) stack.push(full);
                else if (st.isFile()) total += st.size;
            }
        }
    } catch {
        // Best-effort — não bloqueia a quarentena por falha ao medir tamanho.
    }
    return total;
}

module.exports = { quarantine };
