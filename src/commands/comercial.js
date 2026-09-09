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
                const cfg = CommerceConfig.getConfig();

                // REPARO (Fase 9): loja já configurada, cargo de staff já
                // existe, mas falta o canal de logs de vendas (setup
                // parcial antigo, ou uma falha no meio da criação de
                // canais numa execução anterior). Sem este canal, toda
                // notificação de falha de provisionamento (Fases 7/8) cai
                // num no-op silencioso — reparo cirúrgico, só cria o que
                // falta, nunca toca no resto da estrutura já existente.
                if (cfg.staff_role_id && CommerceConfig.getMissingCriticalFields().includes('sales_log_channel_id')) {
                    await interaction.deferReply({ ephemeral: true });
                    try {
                        const guild = interaction.guild;
                        const salesLogChannel = await guild.channels.create({
                            name: 'logs-de-vendas',
                            type: ChannelType.GuildText,
                            parent: cfg.staff_category_id || undefined,
                        });
                        CommerceConfig.saveChannelStructure({ sales_log_channel_id: salesLogChannel.id });
                        return interaction.editReply({
                            content: `✅ Canal de logs de vendas criado: ${salesLogChannel}. Falhas de provisionamento voltam a ser notificadas lá.`,
                        });
                    } catch (err) {
                        console.error('❌ Erro ao reparar o canal de logs de vendas:', err);
                        return interaction.editReply({ content: `❌ Erro ao criar o canal de logs de vendas: ${err.message}` });
                    }
                }

                if (cfg.staff_role_id) {
                    return interaction.reply({
                        content: '⚠️ A loja já está configurada. Para reorganizar os canais, faça isso manualmente no Discord — este comando nunca recria a estrutura pra evitar duplicar categorias.',
                        ephemeral: true,
                    });
                }
                // REPARO (Fase 4): a loja já existe mas foi configurada
                // antes do cargo de visibilidade da staff existir — cria
                // só o cargo que falta e aplica no canal-categoria staff já
                // existente, sem tocar em mais nada. Este cargo é SÓ pra
                // enxergar os canais staff — nunca é checado como
                // autorização (isso continua 100% dentro dos managers via
                // CommerceStaffManager.hasCommercePermission()).
                await interaction.deferReply({ ephemeral: true });
                try {
                    const guild = interaction.guild;
                    const staffRole = await guild.roles.create({
                        name: 'Atlantic Host — Comercial',
                        mentionable: false,
                        reason: 'Reparo Fase 4 — visibilidade dos canais comerciais (nunca usado como autorização)',
                    });
                    if (cfg.staff_category_id) {
                        const staffCategory = await guild.channels.fetch(cfg.staff_category_id).catch(() => null);
                        if (staffCategory) {
                            await staffCategory.permissionOverwrites.edit(staffRole.id, {
                                ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
                            }).catch(() => {});
                        }
                    }
                    CommerceConfig.saveChannelStructure({ staff_role_id: staffRole.id });
                    return interaction.editReply({
                        content: `✅ Cargo de visibilidade da staff criado: ${staffRole}. Use \`/comercial-equipe conceder\` pra conceder permissão comercial — o cargo é atribuído automaticamente junto.`,
                    });
                } catch (err) {
                    console.error('❌ Erro ao reparar a estrutura da loja:', err);
                    return interaction.editReply({ content: `❌ Erro ao criar o cargo de staff: ${err.message}` });
                }
            }

            await interaction.deferReply({ ephemeral: true });
            const guild = interaction.guild;

            try {
                // Cargo de VISIBILIDADE dos canais staff — criado antes da
                // categoria pra já entrar no overwrite dela. Nunca é a
                // fonte de autorização: quem decide permissão real é
                // sempre CommerceStaffManager.hasCommercePermission(),
                // dentro dos managers.
                const staffRole = await guild.roles.create({
                    name: 'Atlantic Host — Comercial',
                    mentionable: false,
                    reason: 'Estrutura da loja comercial — visibilidade dos canais staff',
                });
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
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                        { id: staffRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    ],
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
                    staff_role_id: staffRole.id,
                });

                await interaction.editReply({
                    content:
                        `✅ Estrutura criada:\n` +
                        `**Loja:** ${salesPanelChannel} · ${faqChannel}\n` +
                        `**Staff:** ${staffPanelChannel} · ${ordersReviewChannel} · ${proofsChannel} · ${salesLogChannel}\n` +
                        `**Cargo de visibilidade staff:** ${staffRole}\n\n` +
                        `Use \`/painel-comercial\` em ${staffPanelChannel} para publicar o painel administrativo, \`/painel-de-vendas\` em ${salesPanelChannel} para publicar a vitrine pro cliente, e \`/comercial-equipe conceder\` para dar permissão comercial a alguém (concede o cargo ${staffRole} automaticamente).`,
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
    {
        // CORREÇÃO (Fase 4 — fricção operacional documentada na Fase 3):
        // um COMMERCE_STAFF ativo (concedido só no banco, via
        // CommerceStaffManager) não enxergava os canais staff sem alguém
        // atribuir manualmente o cargo do Discord. Este comando junta as
        // duas coisas num só passo — mas o cargo do Discord aqui é
        // SEMPRE só uma conveniência de VISIBILIDADE. A autorização real
        // nunca depende dele: é sempre CommerceStaffManager.hasCommercePermission()
        // (linha em commerce_staff no banco), revalidada dentro de cada
        // manager, independente de o usuário ter ou não o cargo.
        data: new SlashCommandBuilder()
            .setName('comercial-equipe')
            .setDescription('Concede ou revoga permissão comercial (COMMERCE_STAFF) a um usuário')
            .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
            .addSubcommand((sub) => sub
                .setName('conceder')
                .setDescription('Concede COMMERCE_STAFF a um usuário')
                .addUserOption((opt) => opt.setName('usuario').setDescription('Usuário a conceder').setRequired(true)))
            .addSubcommand((sub) => sub
                .setName('revogar')
                .setDescription('Revoga COMMERCE_STAFF de um usuário')
                .addUserOption((opt) => opt.setName('usuario').setDescription('Usuário a revogar').setRequired(true))),

        async execute(interaction) {
            registerUser(interaction.user);
            const CommerceStaffManager = require('../managers/commerce/CommerceStaffManager');
            const target = interaction.options.getUser('usuario', true);
            const sub = interaction.options.getSubcommand();

            await interaction.deferReply({ ephemeral: true });
            try {
                const cfg = CommerceConfig.getConfig();
                if (sub === 'conceder') {
                    CommerceStaffManager.grant(target.id, interaction.user.id, interaction.guild?.id || null);
                    if (cfg?.staff_role_id) {
                        const member = await interaction.guild.members.fetch(target.id).catch(() => null);
                        if (member) await member.roles.add(cfg.staff_role_id).catch(() => {});
                    }
                    return interaction.editReply({
                        content: `✅ ${target} agora tem permissão comercial (COMMERCE_STAFF).` +
                            (cfg?.staff_role_id ? '' : ' ⚠️ Cargo de visibilidade ainda não existe — rode `/configurar-loja` de novo pra criá-lo.'),
                    });
                }

                CommerceStaffManager.revoke(target.id, interaction.user.id);
                if (cfg?.staff_role_id) {
                    const member = await interaction.guild.members.fetch(target.id).catch(() => null);
                    if (member) await member.roles.remove(cfg.staff_role_id).catch(() => {});
                }
                return interaction.editReply({ content: `✅ ${target} não tem mais permissão comercial (COMMERCE_STAFF).` });
            } catch (err) {
                return interaction.editReply({ content: `❌ ${err.message}` });
            }
        },
    },
];
