/**
 * RECOVERY MANAGER (Kamikaze Mode)
 *
 * Wrapper fino em cima de `backupManager.restoreBackup()` — não duplica
 * descriptografia, verificação de checksum, validação de zip-slip/bomb ou
 * extração, tudo isso já existe e é auditado. A única coisa nova aqui é a
 * prioridade alta na fila (pra não esperar atrás de backups/restores de
 * rotina de outros bots) e o contrato de retorno explícito pro
 * IncidentResponseManager decidir o próximo estado.
 *
 * Não decide reiniciar o bot — isso é uma etapa separada e deliberada do
 * IncidentResponseManager, só depois que a restauração for confirmada e as
 * credenciais forem tratadas.
 */
const { restoreBackup } = require('../backupManager');

/**
 * @param {object} bot
 * @param {object} snapshot - linha de backup retornada por SnapshotManager.findLastSafeSnapshot
 * @returns {{ success: boolean, error?: string }}
 */
async function restoreSafeSnapshot(bot, snapshot) {
    try {
        await restoreBackup(snapshot.id, { priority: 'high' });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

module.exports = { restoreSafeSnapshot };
