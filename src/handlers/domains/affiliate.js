/**
 * DOMÍNIO: AFFILIATE
 * Extraído do interactionHandler monolítico (v8.2 modular).
 */
const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    StringSelectMenuBuilder, AttachmentBuilder,
    ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { query, get, run } = require('../../database/database');
const config = require('../../../config');
const fs = require('fs');
const path = require('path');

const { hasPermission, getUser } = require('../../managers/userManager');
const { logSecurityEvent, logAction } = require('../../managers/logManager');
const { checkRateLimit, formatRetryAfter } = require('../../utils/rateLimiter');

const EXACT = ['affiliate_panel', 'affiliate_set_referrer', 'modal_affiliate_set_referrer', 'affiliate_redeem'];
const PREFIXES = ['modal_affiliate_'];

function match(customId) {
    if (EXACT.includes(customId)) return true;
    return PREFIXES.some(p => customId.startsWith(p));
}

async function handle(interaction, helpers = {}) {
    const customId = interaction.customId;
    // helpers opcionais (compat)

if (customId === 'affiliate_panel') {
    const { getAffiliateStats, getOrCreateAffiliateCode } = require('../../managers/affiliateManager');
    const code = getOrCreateAffiliateCode(interaction.user.id);
    const stats = getAffiliateStats(interaction.user.id);

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('🤝 Programa de Afiliados')
        .setDescription(
            `Indique novos clientes e ganhe comissões sobre cada compra aprovada!\n\n` +
            `**Seu Código:** \`${code}\`\n` +
            `**Seu Saldo:** \`R$ ${stats.balance.toFixed(2)}\`\n` +
            `**Indicações:** \`${stats.referrals}\` usuários\n\n` +
            `*A comissão atual é de 10% sobre o valor total da venda.*`
        );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('affiliate_redeem').setLabel('Resgatar Saldo').setEmoji('💰').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('affiliate_set_referrer').setLabel('Inserir Código de Convite').setEmoji('🎟').setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

else if (customId === 'affiliate_set_referrer') {
    const modal = new ModalBuilder()
        .setCustomId('modal_affiliate_set_referrer')
        .setTitle('🎟 Inserir Código de Convite')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('referrer_code')
                    .setLabel('Código do Padrinho')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('EX: ABC123')
                    .setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId === 'modal_affiliate_set_referrer') {
    const code = interaction.fields.getTextInputValue('referrer_code').trim().toUpperCase();
    const { setReferral } = require('../../managers/affiliateManager');

    try {
        setReferral(interaction.user.id, code);
        await interaction.reply({ content: '✅ Padrinho vinculado com sucesso! Você agora faz parte da rede de indicações.', ephemeral: true });
    } catch (err) {
        await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
}

// CORREÇÃO (feature quebrada): o botão "Resgatar Saldo" existia na UI mas
// não tinha handler nenhum — clicar não fazia absolutamente nada, e não
// havia forma de um afiliado efetivamente sacar o saldo acumulado.
else if (customId === 'affiliate_redeem') {
    const user = getUser(interaction.user.id);
    if (!user || !user.balance || user.balance <= 0) {
        return interaction.reply({ content: `${config.emojis.error} Você não possui saldo disponível para resgate.`, ephemeral: true });
    }

    const amount = user.balance;
    // Zera o saldo já na solicitação para evitar resgate duplicado (double-click)
    // enquanto o pagamento manual é processado pela equipe.
    run('UPDATE users SET balance = 0 WHERE id = ?', [interaction.user.id]);
    logAction(null, interaction.user.id, 'AFFILIATE_REDEEM_REQUEST', `Solicitou resgate de R$ ${amount.toFixed(2)}`);

    const { sendAlert } = require('../../managers/alertManager');
    await sendAlert(
        '💰 Solicitação de Resgate de Afiliado',
        `<@${interaction.user.id}> (\`${interaction.user.id}\`) solicitou o resgate de **R$ ${amount.toFixed(2)}**. Efetue o pagamento manualmente e confirme com o usuário.`,
        'info'
    );

    await interaction.reply({
        content: `${config.emojis.success} Solicitação de resgate de \`R$ ${amount.toFixed(2)}\` enviada! Nossa equipe entrará em contato para efetuar o pagamento.`,
        ephemeral: true
    });
}

    return true;
}

module.exports = { match, handle };
