/**
 * GERENCIADOR DE AGENDAMENTO (Scheduler)
 *
 * CORREÇÃO (feature nunca implementada): `node-cron` já estava no
 * package.json como dependência, e config.backup.autoBackup/dailyBackup já
 * existiam — mas nada em lugar nenhum do código realmente agendava um
 * backup automático. As flags eram só decorativas.
 *
 * Este módulo agenda o backup diário de todos os bots não-suspensos. Os
 * backups em si já passam pela fila serial (queueManager), então disparar
 * vários de uma vez aqui é seguro — o sistema processa um por vez sozinho,
 * sem sobrecarregar CPU/disco.
 */
const cron = require('node-cron');
const config = require('../../config');
const { query } = require('../database/database');
const { createBackup } = require('./backupManager');
const { sendAlert } = require('./alertManager');

let dailyBackupJob = null;

/**
 * Roda o backup automático de todos os bots não-suspensos.
 * Exportado separadamente para permitir disparo manual (ex: comando de
 * diagnóstico, ou testes) sem depender do agendamento do cron.
 */
async function runDailyBackups() {
    const bots = query('SELECT id, name FROM bots WHERE suspended = 0');
    console.log(`🗓️  Iniciando backup diário automático de ${bots.length} bot(s)...`);

    const results = await Promise.allSettled(
        bots.map(bot => createBackup(bot.id, 'daily'))
    );

    const ok = results.filter(r => r.status === 'fulfilled').length;
    const failed = results
        .map((r, i) => ({ r, bot: bots[i] }))
        .filter(x => x.r.status === 'rejected');

    console.log(`🗓️  Backup diário concluído: ${ok} sucesso(s), ${failed.length} falha(s).`);

    if (failed.length > 0) {
        const details = failed.slice(0, 10).map(f => `• ${f.bot.name}: ${f.r.reason.message}`).join('\n');
        await sendAlert(
            '⚠️ Falhas no Backup Diário Automático',
            `${failed.length} de ${bots.length} bot(s) falharam no backup automático:\n${details}${failed.length > 10 ? `\n... e mais ${failed.length - 10}` : ''}`,
            'warning'
        );
    }

    return { total: bots.length, ok, failed: failed.length };
}

/**
 * Inicia os agendamentos. Chamado uma vez no boot do painel (index.js).
 */
function startScheduler() {
    if (config.backup.dailyBackup) {
        // Todo dia às 03:00 (horário do servidor) — horário de baixo uso típico.
        dailyBackupJob = cron.schedule('0 3 * * *', () => {
            runDailyBackups().catch(err => console.error('⚠️ Erro no backup diário automático:', err.message));
        });
        console.log('🗓️  Backup diário automático agendado (03:00 todos os dias).');
    } else {
        console.log('🗓️  Backup diário automático desativado (config.backup.dailyBackup = false).');
    }
}

/**
 * Para os agendamentos (usado no graceful shutdown, evita timer órfão).
 */
function stopScheduler() {
    if (dailyBackupJob) {
        dailyBackupJob.stop();
        dailyBackupJob = null;
    }
}

module.exports = { startScheduler, stopScheduler, runDailyBackups };
