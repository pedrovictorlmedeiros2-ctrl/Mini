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

/**
 * Notifica o dono sobre um incidente de segurança (Kamikaze Mode) tratado
 * automaticamente. Linguagem sempre profissional e conservadora — nunca
 * "ataque", sempre "comportamento potencialmente malicioso". NUNCA inclui
 * trecho de código, linha bruta de log de segurança, token ou valor de env
 * var — só o resumo fixo do que foi feito + o ID do incidente.
 *
 * @param {string} botId
 * @param {object} incident
 * @param {number} incident.id
 * @param {boolean} incident.restarted - se o bot foi reiniciado no final
 * @param {object|null} incident.snapshot - linha de backup usada (ou null se nenhum foi restaurado)
 */
async function notifyKamikazeIncident(botId, incident) {
    const bot = get('SELECT name, code FROM bots WHERE id = ?', [botId]);
    if (!bot) return;

    const lines = [
        `⚠️ **Comportamento potencialmente malicioso detectado no seu bot** \`${bot.name} (${bot.code})\`.`,
        '',
        'Por segurança, tomamos as seguintes medidas automáticas:',
        '🛑 O bot foi isolado imediatamente (parado e sem acesso à rede)',
        '💾 O ambiente anterior foi preservado em quarentena para investigação',
    ];

    if (incident.snapshot) {
        const when = incident.snapshot.created_at || 'desconhecida';
        lines.push(`♻️ Um backup seguro anterior foi restaurado (criado em ${when})`);
    } else {
        lines.push('⚠️ Não foi possível localizar um backup seguro para restaurar automaticamente — o ambiente permanece em quarentena, aguardando revisão manual.');
    }

    lines.push('🔑 As variáveis de ambiente do bot foram revogadas por precaução');

    if (incident.restarted) {
        lines.push('▶️ O bot foi reiniciado com o ambiente restaurado');
    } else {
        lines.push('⏸️ O bot **não foi reiniciado automaticamente** — cadastre um novo token do Discord (Editar Token) para reativá-lo. O token anterior foi invalidado localmente por precaução (o Discord em si só é invalidado por você, no Developer Portal).');
    }

    lines.push('', `**ID do incidente:** \`${incident.id}\` — guarde para consultar com o suporte.`);

    const message = lines.join('\n');

    // Diferente do resto do alertManager (que é "fire and forget" de
    // propósito), aqui esperamos as duas notificações de verdade antes de
    // devolver o controle — o IncidentResponseManager só marca o incidente
    // como resolvido depois desta etapa, então vale garantir que a
    // tentativa de notificar já aconteceu (best-effort, nunca lança:
    // sendAlert/notifyBotOwner engolem seus próprios erros internamente).
    await Promise.all([
        sendAlert(`🛡️ Kamikaze Mode acionado: ${bot.name}`, message, 'error'),
        notifyBotOwner(botId, '⚠️ Comportamento potencialmente malicioso detectado no seu bot', message),
    ]);
}

module.exports = {
    sendAlert,
    alertBotCrash,
    alertResourceLimit,
    alertResourceWarning,
    notifyBotOwner,
    notifyKamikazeIncident,
};
