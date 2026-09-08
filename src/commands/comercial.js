/**
 * COMANDO /configurar-loja — cria a estrutura de canais do sistema
 * comercial (Fase 3): categoria pública 🛒 LOJA + categoria privada
 * 💼 COMERCIAL — STAFF, com os canais fixos pedidos. Idempotente — se já
 * configurado, informa e não recria nada (nunca duplica categorias).
 */
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const { registerUser } = require('../managers/userManager');
const CommerceConfig = require('../managers/commerce/CommerceConfig');

module.exports = [
    {
        data: new SlashCommandBuilder()
            .setName('configurar-loja')
            .setDescription('Cria a estrutura de canais da loja comercial (execução única)')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        async execute(interaction) {
            registerUser(interaction.user);

            if (CommerceConfig.isConfigured()) {
                return interaction.reply({
                    content: '⚠️ A loja já está configurada. Para reorganizar os canais, faça isso manualmente no Discord — este comando nunca recria a estrutura pra evitar duplicar categorias.',
                    ephemeral: true,
                });
            }

            await interaction.deferReply({ ephemeral: true });
            const guild = interaction.guild;

            try {
                const publicCategory = await guild.channels.create({ name: '🛒 LOJA', type: ChannelType.GuildCategory });
                const salesPanelChannel = await guild.channels.create({
                    name: 'painel-de-vendas',
                    type: ChannelType.GuildText,
                    parent: publicCategory.id,
                    // Painel é só leitura pro público — evita spam em cima dos
                    // embeds de venda; dúvidas têm canal próprio.
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionFlagsBits.SendMessages], allow: [PermissionFlagsBits.ViewChannel] },
                    ],
                });
                const faqChannel = await guild.channels.create({
                    name: 'duvidas-sobre-planos',
                    type: ChannelType.GuildText,
                    parent: publicCategory.id,
                });

                const staffCategory = await guild.channels.create({
                    name: '💼 COMERCIAL — STAFF',
                    type: ChannelType.GuildCategory,
                    // Privado por padrão — nega @everyone. Administradores do
                    // Discord sempre enxergam independente de overwrite; um
                    // papel de staff específico pode ser configurado depois
                    // (painel admin) pra ampliar a visibilidade SEM dar
                    // Administrator completo. Isto é só uma camada de
                    // conveniência/descoberta — a permissão de verdade
                    // (hasCommercePermission) é sempre checada dentro dos
                    // managers, nunca só por quem consegue ver o canal.
                    permissionOverwrites: [{ id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }],
                });
                const staffPanelChannel = await guild.channels.create({ name: 'painel-comercial', type: ChannelType.GuildText, parent: staffCategory.id });
                const ordersReviewChannel = await guild.channels.create({ name: 'pedidos-em-analise', type: ChannelType.GuildText, parent: staffCategory.id });
                const proofsChannel = await guild.channels.create({ name: 'comprovantes', type: ChannelType.GuildText, parent: staffCategory.id });
                const salesLogChannel = await guild.channels.create({ name: 'logs-de-vendas', type: ChannelType.GuildText, parent: staffCategory.id });

                CommerceConfig.saveChannelStructure({
                    guild_id: guild.id,
                    public_category_id: publicCategory.id,
                    sales_panel_channel_id: salesPanelChannel.id,
                    faq_channel_id: faqChannel.id,
                    staff_category_id: staffCategory.id,
                    staff_panel_channel_id: staffPanelChannel.id,
                    orders_review_channel_id: ordersReviewChannel.id,
                    proofs_channel_id: proofsChannel.id,
                    sales_log_channel_id: salesLogChannel.id,
                    staff_role_id: null,
                });

                await interaction.editReply({
                    content:
                        `✅ Estrutura criada:\n` +
                        `**Loja:** ${salesPanelChannel} · ${faqChannel}\n` +
                        `**Staff:** ${staffPanelChannel} · ${ordersReviewChannel} · ${proofsChannel} · ${salesLogChannel}\n\n` +
                        `Use \`/painel-comercial\` em ${staffPanelChannel} para publicar o painel administrativo, e \`/painel-de-vendas\` em ${salesPanelChannel} para publicar a vitrine pro cliente.`,
                });
            } catch (err) {
                console.error('❌ Erro ao configurar a loja:', err);
                await interaction.editReply({ content: `❌ Erro ao criar a estrutura de canais: ${err.message}` });
            }
        },
    },
    {
        data: new SlashCommandBuilder()
            .setName('painel-de-vendas')
            .setDescription('Publica a vitrine pública da loja neste canal'),

        async execute(interaction) {
            registerUser(interaction.user);
            const { publishStorefront } = require('../handlers/domains/commerce');
            await publishStorefront(interaction);
        },
    },
    {
        data: new SlashCommandBuilder()
            .setName('painel-comercial')
            .setDescription('Publica o painel administrativo/staff neste canal')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        async execute(interaction) {
            registerUser(interaction.user);
            const { publishStaffPanel } = require('../handlers/domains/commerce');
            await publishStaffPanel(interaction);
        },
    },
];
