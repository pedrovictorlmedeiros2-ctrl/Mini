/**
 * COMANDO PRINCIPAL /painel e Comandos de Vendas
 */
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    AttachmentBuilder,
    PermissionFlagsBits,
    ChannelType
} = require('discord.js');
const { get } = require('../database/database');
const { getSystemStats } = require('../managers/processManager');
const { registerUser } = require('../managers/userManager');
const { formatProcessUptime } = require('../utils/format');
const { getUserPlanInfo } = require('../managers/planManager');
const { getMetricsSummary } = require('../managers/metricsManager');
const { getRecentAuditEvents } = require('../managers/auditManager');
const config = require('../../config');
const path = require('path');
const fs = require('fs');

module.exports = [
    {
        data: new SlashCommandBuilder()
            .setName('painel')
            .setDescription('Abre o painel de controle de hospedagem'),

        async execute(interaction) {
            registerUser(interaction.user);
            await interaction.deferReply({ ephemeral: true });

            try {
                const stats = await getSystemStats();
                const totalBots = get('SELECT COUNT(*) as count FROM bots').count;
                const onlineBots = get("SELECT COUNT(*) as count FROM bots WHERE status = 'online'").count;
                const offlineBots = totalBots - onlineBots;
                const plan = getUserPlanInfo(interaction.user.id);
                const metrics = getMetricsSummary();
                const onlineMetric = metrics.bot_online?.last || 0;
                const totalMetric = metrics.bot_total?.last || 0;
                const recentAudit = getRecentAuditEvents(3);
                const auditSummary = recentAudit.length
                    ? recentAudit.map(entry => `• ${entry.action}: ${entry.details}`).join('\n')
                    : 'Nenhum evento recente.';

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
                        `**📈 Métricas:** \`${onlineMetric}/${totalMetric}\` bots online\n\n` +
                        `**🧾 Auditoria recente:**\n${auditSummary}\n\n` +
                        `**💳 Seu Plano:** \`${plan.name}\` (\`${plan.currentBots}/${plan.maxBots}\` bots)`
                    )
                    .setFooter({ text: `Solicitado por ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
                    .setTimestamp();

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('add_bot').setLabel('Adicionar Bot').setEmoji(config.emojis.add).setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('quick_deploy').setLabel('Quick Deploy').setEmoji('⚡').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('my_bots').setLabel('Meus Bots').setEmoji(config.emojis.myBots).setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('settings').setLabel('Configurações').setEmoji(config.emojis.settings).setStyle(ButtonStyle.Secondary)
                );

                await interaction.editReply({ embeds: [embed], components: [row] });
            } catch (err) {
                console.error('❌ Erro ao abrir painel:', err);
                await interaction.editReply({ content: `❌ Erro ao carregar o painel: ${err.message}` });
            }
        },
    },
    {
        data: new SlashCommandBuilder()
            .setName('criar-painel-vendas')
            .setDescription('Cria o painel de vendas de planos')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        async execute(interaction) {
            // CORREÇÃO: sem isto, quem nunca rodou /painel antes não tinha
            // sequer um registro na tabela users — e o auto-bootstrap de admin
            // do dono (ver registerUser em userManager.js) nunca era acionado
            // por este comando.
            registerUser(interaction.user);

            const embed = new EmbedBuilder()
                .setColor('#00AAFF')
                .setTitle('🚀 Hospedagem de Bots - Atlantic Host')
                .setDescription(
                    'Selecione um plano para iniciar sua contratação.\n\n' +
                    'Nossos planos oferecem o melhor desempenho e segurança para o seu bot.'
                )
                .setFooter({ text: 'Clique no botão abaixo para comprar' });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('sales_buy_plan').setLabel('Comprar Plano').setEmoji('🛒').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('sales_view_plans').setLabel('Ver Planos').setEmoji('📋').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('sales_apply_coupon_global').setLabel('Aplicar Cupom').setEmoji('🎟').setStyle(ButtonStyle.Secondary)
            );

            // CORREÇÃO: usava uma URL externa de exemplo que nunca existiu de
            // verdade (setImage('https://i.imgur.com/your-banner-url.png')) —
            // o Discord falha em carregar isso em silêncio, sem erro nenhum,
            // então a imagem simplesmente nunca aparecia. Mesmo padrão já usado
            // em 'back_to_panel': manda a imagem como anexo junto da mensagem,
            // em vez de depender de um link externo que pode cair a qualquer hora.
            const salesBannerPath = path.resolve(config.system.salesBannerPath);
            if (fs.existsSync(salesBannerPath)) {
                const attachment = new AttachmentBuilder(salesBannerPath, { name: 'vendas-banner.png' });
                embed.setImage('attachment://vendas-banner.png');
                await interaction.reply({ embeds: [embed], components: [row], files: [attachment] });
            } else {
                await interaction.reply({ embeds: [embed], components: [row] });
            }
        }
    },
    {
        data: new SlashCommandBuilder()
            .setName('admin-vendas')
            .setDescription('Painel administrativo de vendas')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        async execute(interaction) {
            // CORREÇÃO CRÍTICA: esta era a causa raiz do "Acesso negado" em
            // TODOS os botões deste painel — o Discord deixava o dono/admin
            // abrir o /admin-vendas (via PermissionFlagsBits.Administrator),
            // mas cada botão clicado checa hasPermission(id, 'admin') contra o
            // banco INTERNO do bot, que nunca promovia ninguém a admin
            // automaticamente. registerUser (ver userManager.js) agora cuida
            // disso pro dono configurado em OWNER_ID.
            registerUser(interaction.user);

            const embed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('⚙️ Administração de Vendas')
                .setDescription('Gerencie planos, cupons, pedidos e configurações financeiras.');

            const row1 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('admin_manage_plans').setLabel('Gerenciar Planos').setEmoji('📦').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('admin_manage_coupons').setLabel('Gerenciar Cupons').setEmoji('🎟').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('admin_config_pix').setLabel('Configurar Pix').setEmoji('💰').setStyle(ButtonStyle.Secondary)
            );

            const row2 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('admin_view_orders').setLabel('Ver Pedidos').setEmoji('📋').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('admin_stats').setLabel('Estatísticas').setEmoji('📈').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('admin_settings').setLabel('Configurações').setEmoji('⚙').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('admin_set_user_plan').setLabel('Definir Plano de Usuário').setEmoji('👤').setStyle(ButtonStyle.Secondary)
            );

            // NOVA FEATURE: antes não existia nenhum jeito de dar acesso de
            // staff (moderador/admin) a mais ninguém além do dono — este
            // botão usa o handler 'admin_set_user_role' criado junto com a
            // correção do bug de "Acesso negado" nos botões deste painel.
            const row3 = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('admin_set_user_role').setLabel('Definir Cargo de Usuário').setEmoji('🛡').setStyle(ButtonStyle.Secondary)
            );

            await interaction.reply({ embeds: [embed], components: [row1, row2, row3], ephemeral: true });
        }
    }
];
