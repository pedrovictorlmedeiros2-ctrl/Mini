/**
 * SNAPSHOT MANAGER (Kamikaze Mode)
 *
 * Localiza o último snapshot (backup) SEGURO de um bot, pra restauração
 * automática. Não reimplementa nada de backup/restore — só decide QUAL
 * backup é confiável, em cima do que `backupManager.listBackups()` já
 * retorna.
 *
 * Regra de segurança (fail-safe, conforme pedido): se não houver NENHUM
 * backup marcado 'safe', retorna null — nunca inventa uma restauração a
 * partir de um backup de status desconhecido ou marcado como comprometido.
 * Reproduz exatamente o exemplo do pedido original: snapshot #17 e #18
 * seguros, #19 (a pasta ao vivo, nunca virou backup) é o que a quarentena
 * captura, não algo que o SnapshotManager precisa avaliar.
 */
const { listBackups } = require('../backupManager');

/**
 * @param {string} botId
 * @returns {object|null} a linha de backup mais recente com safety_status
 *   'safe', ou null se nenhuma existir.
 */
function findLastSafeSnapshot(botId) {
    // listBackups já retorna ORDER BY created_at DESC — a primeira 'safe'
    // encontrada é a mais recente.
    const backups = listBackups(botId);
    return backups.find((b) => b.safety_status === 'safe') || null;
}

/**
 * Usado por backupManager.createBackup(): um backup criado enquanto o bot
 * já tem um incidente em andamento não é confiável (o próprio processo de
 * criação do backup pode ter rodado sob o código comprometido) — nasce
 * 'flagged_compromised' em vez de 'safe'.
 *
 * @param {string} botId
 * @returns {number|null} id do incidente aberto, ou null se não houver nenhum
 */
function findOpenIncidentId(botId) {
    const { get } = require('../../database/database');
    const row = get(
        `SELECT id FROM incidents
         WHERE bot_id = ? AND status NOT IN ('resolved', 'resolved_partial', 'failed_safe')
         ORDER BY started_at DESC LIMIT 1`,
        [botId]
    );
    return row ? row.id : null;
}

module.exports = { findLastSafeSnapshot, findOpenIncidentId };
