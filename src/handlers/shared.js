/**
 * Utilitários compartilhados entre handlers de domínio.
 */
const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { get } = require('../database/database');
const { formatProcessUptime } = require('../utils/format');
const { getSystemStats } = require('../managers/processManager');
const { getUserPlanInfo } = require('../managers/planManager');
const config = require('../../config');
const fs = require('fs');
const path = require('path');

const cooldowns = new Map();

function checkCooldown(userId) {
    const now = Date.now();
    const last = cooldowns.get(userId) || 0;
    if (now - last < config.security.antiSpamCooldown) return false;
    cooldowns.set(userId, now);
    return true;
}

/** Aceita tokens modernos do Discord (MTA..., OTk..., etc.) */
const TOKEN_REGEX = /^[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}$/;

async function buildMainPanelEmbed(interaction) {
    const stats = await getSystemStats();
    const totalBots = get('SELECT COUNT(*) as count FROM bots').count;
    const onlineBots = get("SELECT COUNT(*) as count FROM bots WHERE status = 'online'").count;
    const offlineBots = totalBots - onlineBots;
    const now = new Date();
    const plan = getUserPlanInfo(interaction.user.id);

    const embed = new EmbedBuilder()
        .setColor(config.bot.color)
        .setTitle(`${config.emojis.start} **PAINEL DE HOSPEDAGEM**`)
        .setDescription(
            `> Sistema de hospedagem profissional para bots Discord\n\n` +
            `**${config.emojis.myBots} Bots Hospedados:** \`${totalBots}\`\n` +
            `**${config.emojis.powerOn} Bots Ligados:** \`${onlineBots}\`\n` +
            `**${config.emojis.powerOff} Bots Desligados:** \`${offlineBots}\`\n\n` +
            `**${config.emojis.cpu} CPU Utilizada:** \`${stats.cpu}%\`\n` +
            `**${config.emojis.ram} RAM Utilizada:** \`${stats.ramUsed} / ${stats.ramTotal} (${stats.ramPercent}%)\`\n` +
            `**${config.emojis.disk} Espaço Utilizado:** \`${stats.diskUsed} / ${stats.diskTotal} (${stats.diskPercent}%)\`\n\n` +
            `**${config.emojis.uptime} Uptime:** \`${formatProcessUptime(process.uptime())}\`\n` +
            `**${config.emojis.ping} Ping:** \`${interaction.client.ws.ping}ms\`\n` +
            `**${config.emojis.settings} Versão:** \`v${config.bot.version}\`\n\n` +
            `**${config.emojis.lock} Dono do Painel:** <@${config.bot.ownerId}>\n` +
            `**${config.emojis.category} Data:** \`${now.toLocaleDateString('pt-BR')}\`\n` +
            `**${config.emojis.uptime} Hora:** \`${now.toLocaleTimeString('pt-BR')}\`\n\n` +
            `**💳 Seu Plano:** \`${plan.name}\` (\`${plan.currentBots}/${plan.maxBots}\` bots)`
        )
        .setFooter({ text: `Solicitado por ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('add_bot').setLabel('Adicionar Bot').setEmoji(config.emojis.add).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('start_bots').setLabel('Start Bots').setEmoji(config.emojis.start).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('my_bots').setLabel('Meus Bots').setEmoji(config.emojis.myBots).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('settings').setLabel('Configurações').setEmoji(config.emojis.settings).setStyle(ButtonStyle.Secondary)
    );

    return { embed, row };
}

function encodeFilePath(p) {
    return Buffer.from(String(p || ''), 'utf8').toString('base64url');
}

function decodeFilePath(encoded) {
    try {
        return Buffer.from(String(encoded || ''), 'base64url').toString('utf8');
    } catch {
        return '';
    }
}

module.exports = {
    checkCooldown,
    TOKEN_REGEX,
    buildMainPanelEmbed,
    encodeFilePath,
    decodeFilePath,
    cooldowns,
};
