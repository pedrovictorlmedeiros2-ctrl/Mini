/**
 * GERENCIADOR DE ALERTAS — v8.5.2
 * - Webhook para o admin
 * - DM automática para o dono do bot (cliente)
 * - Avisos suaves antes de matar por recurso
 */
const axios = require('axios');
const { get } = require('../database/database');

/**
 * Envia um alerta para o Webhook configurado (admin)
 */
async function sendAlert(title, message, type = 'info') {
    const webhookUrl = process.env.LOG_WEBHOOK_URL;
    if (!webhookUrl) return;

    const colors = {
        info: 3447003,
        warning: 16776960,
        error: 15158332,
        success: 3066993
    };

    const embed = {
        title,
        description: message,
        color: colors[type] || colors.info,
        timestamp: new Date().toISOString(),
        footer: { text: 'Sistema de Alertas • Atlantic Host' }
    };

    try {
        await axios.post(webhookUrl, { embeds: [embed] });
    } catch (err) {
        console.error('❌ Falha ao enviar alerta para Webhook:', err.message);
    }
}

/**
 * Tenta enviar DM para o dono do bot (cliente)
 * Não quebra se o usuário tiver DM fechada.
 */
async function notifyBotOwner(botId, title, message) {
    try {
        const bot = get(
            `SELECT b.name, b.code, b.creator_id
             FROM bots b
             WHERE b.id = ?`,
            [botId]
        );
        if (!bot || !bot.creator_id) return;

        const { getClient } = require('../utils/clientRef');
        const client = getClient();
        if (!client || !client.isReady()) return;

        const user = await client.users.fetch(bot.creator_id).catch(() => null);
        if (!user) return;

        await user.send({
            embeds: [{
                title,
                description: message,
                color: 0xED4245,
                timestamp: new Date().toISOString(),
                footer: { text: `Bot: ${bot.name} (${bot.code})` }
            }]
        }).catch(() => {
            // DM fechada ou bloqueada — ignora silenciosamente
        });
    } catch (err) {
        console.warn('[ALERT] Falha ao notificar dono do bot:', err.message);
    }
}

/**
 * Alerta de queda / crash do bot
 */
function alertBotCrash(botId, code, isCrashLoop = false) {
    const bot = get('SELECT name, code FROM bots WHERE id = ?', [botId]);
    if (!bot) return;

    if (isCrashLoop) {
        const msg =
            `O bot \`${bot.name}\` (\`${bot.code}\`) crashou repetidamente rápido demais.\n` +
            `O **auto-restart foi desativado automaticamente** para não ficar em loop consumindo recursos.\n\n` +
            `**Último código de saída:** \`${code}\`\n` +
            `Verifique os logs, corrija o problema e ligue o bot novamente.`;

        sendAlert(`💀 Crash Loop: ${bot.name}`, msg, 'error');
        notifyBotOwner(botId, '💀 Seu bot entrou em Crash Loop', msg);
        return;
    }

    const msg = `O bot \`${bot.name}\` (\`${bot.code}\`) encerrou com código de saída \`${code}\`.`;
    sendAlert(`🔴 Bot Desconectado: ${bot.name}`, msg, 'error');
    notifyBotOwner(botId, '🔴 Seu bot desconectou', msg);
}

/**
 * Alerta de limite de recursos (bot foi morto pelo watchdog)
 */
function alertResourceLimit(botId, reason) {
    const bot = get('SELECT name, code FROM bots WHERE id = ?', [botId]);
    if (!bot) return;

    const msg =
        `O bot \`${bot.name}\` (\`${bot.code}\`) foi **encerrado automaticamente** pelo sistema.\n\n` +
        `**Motivo:** ${reason}\n\n` +
        `Reduza o consumo de recursos ou peça um plano com limites maiores.`;

    sendAlert(`⚠️ Limite de Recursos: ${bot.name}`, msg, 'warning');
    notifyBotOwner(botId, '⚠️ Seu bot foi desligado por excesso de recursos', msg);
}

/**
 * Aviso suave (ainda não matou) — avisa o dono que está perto do limite
 */
function alertResourceWarning(botId, reason) {
    const bot = get('SELECT name, code FROM bots WHERE id = ?', [botId]);
    if (!bot) return;

    const msg =
        `O bot \`${bot.name}\` (\`${bot.code}\`) está **próximo do limite** de recursos.\n\n` +
        `**Detalhe:** ${reason}\n\n` +
        `Se continuar acima do limite, ele será desligado automaticamente.`;

    sendAlert(`🟡 Aviso de Recursos: ${bot.name}`, msg, 'warning');
    notifyBotOwner(botId, '🟡 Seu bot está perto do limite de recursos', msg);
}

module.exports = {
    sendAlert,
    alertBotCrash,
    alertResourceLimit,
    alertResourceWarning,
    notifyBotOwner
};
