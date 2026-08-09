const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { getRecentAuditEvents } = require('../managers/auditManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('auditoria')
        .setDescription('[Staff] Mostra os eventos recentes de auditoria')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const events = getRecentAuditEvents(15);
        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('🧾 Auditoria recente')
            .setDescription(events.length ? events.map(entry => `• **${entry.action}** — ${entry.details || 'sem detalhes'} (${entry.severity})`).join('\n') : 'Nenhum evento registrado ainda.');
        await interaction.editReply({ embeds: [embed] });
    },
};
