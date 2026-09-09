/**
 * DOMÍNIO: COMMERCE (Fase 3 — UI dentro do Discord)
 *
 * Camada de interação — monta embeds/botões/modais e delega TODA regra
 * de negócio pros managers de `src/managers/commerce/`. Nunca decide
 * nada sozinho: preço, permissão, snapshot, transição de estado — tudo
 * isso já vem calculado/validado dos managers.
 *
 * Convenção de permissão (defesa em profundidade, arquitetura §10): todo
 * handler sensível REVALIDA permissão aqui (pra dar uma resposta de erro
 * rápida e clara) E os managers chamados por baixo TAMBÉM revalidam
 * (nunca confiam só nesta camada) — ver PaymentManager/ProofManager/
 * CommerceStaffManager, que já fazem isso independentemente desta UI.
 *
 * IDs vindos do Discord (customId, valores de select/modal) são sempre
 * tratados como adversariais — nunca usados pra decidir algo sem passar
 * pelo manager correspondente re-checar dono/permissão/estado.
 */
const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    StringSelectMenuBuilder, AttachmentBuilder, ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { get, run, query } = require('../../database/database');
const config = require('../../../config');
const { hasPermission, registerUser } = require('../../managers/userManager');
const { checkRateLimit, formatRetryAfter } = require('../../utils/rateLimiter');
const alertManager = require('../../managers/alertManager');
const clientRef = require('../../utils/clientRef');

const ProductCatalog = require('../../managers/commerce/ProductCatalog');
const OrderManager = require('../../managers/commerce/OrderManager');
const PaymentManager = require('../../managers/commerce/PaymentManager');
const ProofManager = require('../../managers/commerce/ProofManager');
const ProvisioningManager = require('../../managers/commerce/ProvisioningManager');
const EntitlementManager = require('../../managers/commerce/EntitlementManager');
const CommerceStaffManager = require('../../managers/commerce/CommerceStaffManager');
const CommerceConfig = require('../../managers/commerce/CommerceConfig');
const queueManager = require('../../managers/queueManager');

const EXACT = [
    'commerce_view_plans', 'commerce_view_plan_details', 'commerce_buy_plan', 'commerce_renew_plan', 'commerce_support', 'commerce_pay',
    'commerce_send_proof', 'commerce_cancel_order', 'commerce_select_product',
    'commerce_staff_queue', 'commerce_staff_select_order', 'commerce_staff_provisioning_failures',
    'commerce_admin_products', 'commerce_admin_create_product', 'modal_commerce_admin_create_product',
    'commerce_admin_select_product', 'commerce_admin_config_pix', 'modal_commerce_admin_config_pix',
    'commerce_admin_stats', 'commerce_admin_audit',
];
const PREFIXES = [
    'commerce_staff_view_proof_', 'commerce_staff_approve_', 'commerce_staff_reject_', 'modal_commerce_staff_reject_',
    'commerce_staff_request_new_proof_', 'modal_commerce_staff_request_new_proof_',
    'commerce_staff_retry_provisioning_',
    'commerce_admin_publish_product_', 'commerce_admin_pause_product_', 'commerce_admin_archive_product_',
];

function match(customId) {
    if (EXACT.includes(customId)) return true;
    return PREFIXES.some((p) => customId.startsWith(p));
}

// Locks em memória — mesmo princípio já usado em outros pontos do
// sistema (ex.: locks síncronos do IncidentResponseManager): checados e
// setados de forma SÍNCRONA, antes de qualquer `await`, pra fechar a
// janela de corrida entre dois cliques rápidos do mesmo cliente gerando
// duas invocações concorrentes de handle() (cada uma delas retoma em
// pontos diferentes depois de um await, intercaladas pelo event loop).
const buyClaimLocks = new Set(); // userId -> já está criando um pedido agora
const activeProofCollectors = new Set(); // orderId -> já existe um coletor de comprovante esperando

// ── Helpers de embed/exibição — nunca contêm lógica de negócio ──────────

function formatMoney(value) {
    return `R$ ${Number(value).toFixed(2)}`;
}

/**
 * FASE 9 (P1-4): monta a descrição de uma listagem do staff (fila de
 * revisão, falhas de provisionamento) SEM NUNCA ultrapassar o limite de
 * `description` de um embed do Discord (4096 caracteres) — não importa
 * o tamanho do backlog nem o comprimento de cada linha (nome de usuário
 * longo, etc.). Acumula linha por linha até chegar perto do limite
 * (margem de segurança pra caber a nota final), então para e resume o
 * resto — nunca corta uma linha no meio. A ORDEM da lista de entrada
 * nunca é alterada aqui (ambas as queries já ordenam os mais antigos
 * primeiro — são os que precisam de atenção primeiro, e são eles que
 * ficam garantidos visíveis).
 */
function buildTruncatedList(items, formatLineFn, maxChars = 3900) {
    const lines = [];
    let usedChars = 0;
    let shownCount = 0;
    for (const item of items) {
        const line = formatLineFn(item);
        const addedChars = line.length + 1; // +1 pela quebra de linha
        if (usedChars + addedChars > maxChars) break;
        lines.push(line);
        usedChars += addedChars;
        shownCount += 1;
    }
    const remaining = items.length - shownCount;
    if (remaining > 0) {
        lines.push(`… e mais ${remaining} pedido(s) não exibido(s) aqui — resolva os mais antigos (acima) primeiro.`);
    }
    return { text: lines.join('\n'), shownCount, totalCount: items.length };
}

function billingPeriodLabel(period) {
    return period === 'monthly' ? 'mês' : (period || 'mês');
}

function productSummaryLine(p) {
    return `**${p.name}** — \`${formatMoney(p.price)}/${billingPeriodLabel(p.billing_period)}\`\n> 🤖 ${p.max_bots} bot(s) · 🧠 ${p.max_ram}MB RAM · ⚡ ${p.max_cpu}% CPU · 💾 ${p.storage}MB`;
}

function productDetailDescription(p) {
    return (
        `${p.description ? `${p.description}\n\n` : ''}` +
        `**Preço:** \`${formatMoney(p.price)}/${billingPeriodLabel(p.billing_period)}\`\n` +
        `**Recursos:** 🤖 ${p.max_bots} bot(s) · 🧠 ${p.max_ram}MB RAM · ⚡ ${p.max_cpu}% CPU · 💾 ${p.storage}MB armazenamento`
    );
}

async function notifyBuyer(client, userId, content) {
    try {
        const user = await client.users.fetch(userId);
        await user.send(content);
    } catch { /* DM fechada — nunca bloqueia o fluxo */ }
}

async function postToChannel(guild, channelId, payload) {
    if (!channelId) return;
    const channel = guild.channels.cache.get(channelId);
    if (channel) await channel.send(payload).catch(() => {});
}

/**
 * FASE 9 (P1-2): usada só pras notificações que não podem desaparecer em
 * silêncio (falha de provisionamento) — se `sales_log_channel_id` não
 * estiver configurado, `postToChannel()` seria um no-op sem nenhum outro
 * sinal. Cai pro mesmo mecanismo de alerta administrativo do P0-2
 * (`alertManager.sendAlert()` webhook + `clientRef.tryDM()` ao owner) —
 * nunca um mecanismo novo. Nunca lança (mesmo princípio fail-safe de
 * `notifyBuyer()`/`postToChannel()`).
 */
async function notifyStaffOfImportantFailure(guild, channelId, content) {
    if (channelId) {
        await postToChannel(guild, channelId, { content });
        return;
    }
    try {
        await alertManager.sendAlert('[Atlantic Host] Falha comercial sem canal de log configurado', content, 'error');
    } catch { /* nunca bloqueia */ }
    try {
        if (config.bot && config.bot.ownerId) {
            await clientRef.tryDM(config.bot.ownerId, `🚨 **Canal de logs de vendas não configurado.**\n${content}`);
        }
    } catch { /* nunca bloqueia */ }
}

/**
 * FASE 8: núcleo compartilhado de criação do canal de pedido — usado tanto
 * por "Comprar Plano" quanto por "Renovar Plano". A única diferença real
 * entre os dois fluxos é `renewalOfEntitlementId` (persistido no Order já
 * na criação — ver OrderManager.createOrder — pra `commerce_select_product`
 * recuperar mais tarde e repassar a `confirmProduct()`) e o texto de
 * boas-vindas no canal; lock/rate-limit/permissões/criação de canal são
 * idênticos, então vivem num só lugar (nunca duas implementações que podem
 * divergir).
 */
async function createOrderChannel(interaction, buyerId, { renewalOfEntitlementId = null, welcomeText } = {}) {
    // Lock síncrono ANTES de qualquer checagem/await — sem isso, dois
    // cliques rápidos no botão geram duas invocações de handle() que
    // passam pela checagem de "já tem pedido em andamento" ANTES de
    // qualquer uma delas ter criado o pedido (a corrida real fica no
    // intervalo entre esta checagem e o `await guild.channels.create()`
    // mais abaixo) — resultando em dois canais/pedidos pro mesmo cliente.
    // Checar e marcar o lock aqui, no mesmo tick síncrono, fecha essa
    // janela por completo. Mesmo lock compartilhado entre compra e
    // renovação de propósito (Fase 8) — impede também um cliente abrir uma
    // compra E uma renovação ao mesmo tempo.
    if (buyClaimLocks.has(buyerId)) {
        return interaction.reply({ content: '⏳ Já estamos processando seu pedido — aguarde um instante.', ephemeral: true });
    }
    buyClaimLocks.add(buyerId);

    try {
        const existingOrder = get(
            `SELECT channel_id FROM commerce_orders WHERE user_id = ? AND status IN ('DRAFT','AWAITING_PAYMENT','PROOF_SUBMITTED','UNDER_REVIEW')`,
            [buyerId]
        );
        if (existingOrder) {
            return interaction.reply({ content: `❌ Você já possui um pedido em andamento: <#${existingOrder.channel_id}>`, ephemeral: true });
        }

        // Mesma chave de rate limit pra compra e renovação — evita que
        // alternar entre os dois botões vire uma forma de contornar o
        // limite de criação de canais.
        const cartLimit = checkRateLimit(`commerce_cart:${buyerId}`, 10, 60 * 60 * 1000);
        if (!cartLimit.allowed) {
            return interaction.reply({ content: `❌ Muitos pedidos criados recentemente. Tente novamente em ${formatRetryAfter(cartLimit.retryAfterMs)}.`, ephemeral: true });
        }

        await interaction.reply({ content: '⏳ Criando seu pedido...', ephemeral: true });

        let channel;
        try {
            const guild = interaction.guild;
            const cfg = CommerceConfig.getConfig();
            const permissionOverwrites = [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: buyerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
            ];
            if (cfg?.staff_role_id) {
                permissionOverwrites.push({ id: cfg.staff_role_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
            }

            channel = await guild.channels.create({
                name: `pedido-${interaction.user.username}`.slice(0, 90),
                type: ChannelType.GuildText,
                parent: cfg?.public_category_id || undefined,
                permissionOverwrites,
            });

            const order = OrderManager.createOrder({ userId: buyerId, channelId: channel.id, guildId: guild.id, renewalOfEntitlementId });

            const products = ProductCatalog.getPublishedProducts();
            if (products.length === 0) {
                await channel.send('❌ Nenhum plano disponível no momento. Este canal será fechado em 10 segundos.');
                setTimeout(() => channel.delete().catch(() => {}), 10000);
                return interaction.editReply({ content: '❌ Nenhum plano disponível no momento.' });
            }

            const select = new StringSelectMenuBuilder()
                .setCustomId('commerce_select_product')
                .setPlaceholder('Selecione um plano...')
                .addOptions(products.slice(0, 25).map((p) => ({
                    label: p.name,
                    description: `${formatMoney(p.price)}/${billingPeriodLabel(p.billing_period)} | ${p.max_bots} bot(s) | ${p.max_ram}MB RAM`,
                    value: p.id,
                })));
            const row = new ActionRowBuilder().addComponents(select);
            const cancelRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('commerce_cancel_order').setLabel('Cancelar Pedido').setEmoji('❌').setStyle(ButtonStyle.Danger)
            );

            const embed = new EmbedBuilder()
                .setColor('#00AAFF')
                .setTitle(renewalOfEntitlementId ? '🔄 Renovação de Plano' : '🛒 Seu Pedido')
                .setDescription(welcomeText || `Olá ${interaction.user}, selecione um plano abaixo pra continuar.`);

            await channel.send({ content: `${interaction.user}`, embeds: [embed], components: [row, cancelRow] });
            await interaction.editReply({ content: `✅ Pedido criado: ${channel}` });
        } catch (err) {
            console.error('❌ Erro ao criar pedido comercial:', err);
            if (channel?.deletable) {
                try { await channel.delete('Erro ao criar pedido — limpeza automática'); } catch { /* ignora */ }
            }
            await interaction.editReply({ content: '❌ Erro ao criar seu pedido. Tente novamente ou avise a equipe de suporte.' });
        }
    } finally {
        buyClaimLocks.delete(buyerId);
    }
}

// ── PAINÉIS PUBLICADOS PELOS COMANDOS (/painel-de-vendas, /painel-comercial) ──

async function publishStorefront(interaction) {
    const embed = new EmbedBuilder()
        .setColor('#00AAFF')
        .setTitle('🛒 Loja Atlantic Host')
        .setDescription('Escolha um plano de hospedagem abaixo. Precisa de ajuda? Use o canal de dúvidas.');
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('commerce_buy_plan').setLabel('Comprar Plano').setEmoji('🛒').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('commerce_renew_plan').setLabel('Renovar Plano').setEmoji('🔄').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('commerce_view_plans').setLabel('Ver Planos').setEmoji('📋').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('commerce_support').setLabel('Suporte').setEmoji('💬').setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({ embeds: [embed], components: [row] });
}

async function publishStaffPanel(interaction) {
    if (!hasPermission(interaction.user.id, 'admin')) {
        return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
    }
    const embed = new EmbedBuilder()
        .setColor('#FFAA00')
        .setTitle('💼 Painel Comercial')
        .setDescription('Gerencie produtos, revise pedidos e acompanhe as vendas.');
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('commerce_staff_queue').setLabel('Pedidos em Análise').setEmoji('📋').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('commerce_staff_provisioning_failures').setLabel('Falhas de Provisionamento').setEmoji('🚨').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('commerce_admin_products').setLabel('Produtos').setEmoji('📦').setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('commerce_admin_config_pix').setLabel('Configurar Pix').setEmoji('💰').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('commerce_admin_stats').setLabel('Estatísticas').setEmoji('📈').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('commerce_admin_audit').setLabel('Auditoria').setEmoji('🧾').setStyle(ButtonStyle.Secondary)
    );
    // FASE 9: nunca deixa uma configuração incompleta passar em silêncio
    // no momento em que o painel é publicado (é aqui que o admin fica
    // sabendo, não só quando uma falha real acontecer meses depois).
    const missingFields = CommerceConfig.getMissingCriticalFields();
    const warning = missingFields.includes('sales_log_channel_id')
        ? '\n\n⚠️ **Canal de logs de vendas não configurado** — falhas de provisionamento não serão notificadas nesse canal (só via alerta administrativo, se configurado). Rode `/configurar-loja` de novo pra reparar.'
        : '';
    await interaction.reply({ embeds: [embed.setDescription(embed.data.description + warning)], components: [row1, row2] });
}

async function handle(interaction, helpers = {}) {
    const customId = interaction.customId;
    registerUser(interaction.user);

    // ═══════════════════════════════════════════════════════════════════
    // CLIENTE (loja pública)
    // ═══════════════════════════════════════════════════════════════════

    if (customId === 'commerce_view_plans') {
        const plans = ProductCatalog.getPublishedProducts();
        if (plans.length === 0) {
            return interaction.reply({ content: '❌ Nenhum plano disponível no momento.', ephemeral: true });
        }
        const embed = new EmbedBuilder()
            .setColor('#00AAFF')
            .setTitle('📋 Planos Disponíveis')
            .setDescription(plans.map(productSummaryLine).join('\n\n'));
        const detailSelect = new StringSelectMenuBuilder()
            .setCustomId('commerce_view_plan_details')
            .setPlaceholder('Ver detalhes de um plano...')
            .addOptions(plans.slice(0, 25).map((p) => ({
                label: p.name,
                description: `${formatMoney(p.price)}/${billingPeriodLabel(p.billing_period)}`,
                value: p.id,
            })));
        const buyRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('commerce_buy_plan').setLabel('Comprar Plano').setEmoji('🛒').setStyle(ButtonStyle.Success)
        );
        return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(detailSelect), buyRow], ephemeral: true });
    }

    if (customId === 'commerce_view_plan_details') {
        const productId = interaction.values[0];
        const product = ProductCatalog.getProduct(productId);
        // Revalida PUBLISHED aqui mesmo — o select foi montado a partir
        // de getPublishedProducts(), mas o valor que volta é sempre
        // tratado como adversarial (podia ter sido despublicado entre a
        // montagem do menu e o clique, ou forjado).
        if (!product || product.status !== ProductCatalog.PRODUCT_STATUS.PUBLISHED) {
            return interaction.reply({ content: '❌ Este plano não está mais disponível.', ephemeral: true });
        }
        const embed = new EmbedBuilder()
            .setColor('#00AAFF')
            .setTitle(`📋 ${product.name}`)
            .setDescription(productDetailDescription(product));
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('commerce_buy_plan').setLabel('Comprar Plano').setEmoji('🛒').setStyle(ButtonStyle.Success)
        );
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (customId === 'commerce_support') {
        const cfg = CommerceConfig.getConfig();
        const channelMention = cfg?.faq_channel_id ? `<#${cfg.faq_channel_id}>` : 'o canal de dúvidas';
        return interaction.reply({ content: `💬 Tire suas dúvidas em ${channelMention} — nossa equipe responde por lá.`, ephemeral: true });
    }

    if (customId === 'commerce_buy_plan') {
        const buyerId = interaction.user.id;

        // FASE 8: compra tradicional é bloqueada por completo se o cliente
        // já tem um entitlement ATIVO — nunca cria pedido/canal/pagamento
        // antes desta checagem (regra explícita da fase). Um cliente com
        // plano ativo só pode RENOVAR (commerce_renew_plan) — evita o
        // cenário da Fase 7 em que o conflito só era descoberto depois de
        // pagamento e revisão inteiros (EntitlementConflictError só no
        // provisionamento). Elegibilidade de renovação (ativo OU expirado
        // recente) é mais ampla que este bloqueio de propósito — só
        // ENTITLEMENT ATIVO impede a compra tradicional.
        if (EntitlementManager.getActiveEntitlement(buyerId)) {
            const renewRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('commerce_renew_plan').setLabel('Renovar Plano').setEmoji('🔄').setStyle(ButtonStyle.Primary)
            );
            return interaction.reply({
                content: '❌ Você já possui um plano ativo — não é possível comprar um novo. Use **Renovar Plano** abaixo.',
                components: [renewRow],
                ephemeral: true,
            });
        }

        return createOrderChannel(interaction, buyerId);
    }

    if (customId === 'commerce_renew_plan') {
        const buyerId = interaction.user.id;

        // FASE 8: elegível = entitlement ativo OU expirado há pouco tempo
        // (config.commerce.renewalGraceDays) — nunca renovação indefinida
        // de um plano arbitrariamente antigo (EntitlementManager.
        // getRenewalEligibleEntitlement já aplica essa janela).
        const eligible = EntitlementManager.getRenewalEligibleEntitlement(buyerId);
        if (!eligible) {
            return interaction.reply({
                content: '❌ Você não tem nenhum plano ativo ou elegível para renovação no momento. Use **Comprar Plano** para contratar um novo.',
                ephemeral: true,
            });
        }

        const previousOrder = get('SELECT product_snapshot FROM commerce_orders WHERE id = ?', [eligible.order_id]);
        const previousName = previousOrder?.product_snapshot ? JSON.parse(previousOrder.product_snapshot).name : 'seu plano anterior';
        const welcomeText = `Olá ${interaction.user}, você está renovando **${previousName}**. Selecione abaixo o plano desejado pra continuar (pode manter o mesmo ou escolher outro).`;

        return createOrderChannel(interaction, buyerId, { renewalOfEntitlementId: eligible.id, welcomeText });
    }

    if (customId === 'commerce_select_product') {
        const order = OrderManager.getOrderByChannel(interaction.channelId);
        if (!order) return interaction.reply({ content: '❌ Pedido não encontrado.', ephemeral: true });
        // Só o dono do canal pode selecionar — canal já é privado por
        // permissão do Discord, mas revalida contra o banco de qualquer
        // forma (IDs vindos do Discord são tratados como adversariais).
        if (order.user_id !== interaction.user.id) {
            return interaction.reply({ content: '❌ Este pedido não é seu.', ephemeral: true });
        }

        const productId = interaction.values[0];
        let updatedOrder;
        try {
            // FASE 8: repassa `renewal_of_entitlement_id` (gravado na
            // criação do Order — ver commerce_renew_plan/createOrderChannel)
            // de volta pra confirmProduct(), que reescreve essa coluna a
            // cada chamada (default null) — sem isso, confirmar o produto
            // apagaria a intenção de renovação já registrada no pedido.
            updatedOrder = OrderManager.confirmProduct(order.id, productId, order.renewal_of_entitlement_id || null);
            PaymentManager.createPaymentRecord(updatedOrder.id);
        } catch (err) {
            return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }

        const snapshot = JSON.parse(updatedOrder.product_snapshot);
        const embed = new EmbedBuilder()
            .setColor('#00AAFF')
            .setTitle(updatedOrder.renewal_of_entitlement_id ? '🔄 Resumo da Renovação' : '🧾 Resumo do Pedido')
            .setDescription(
                `**Plano:** \`${snapshot.name}\`\n` +
                `**Valor:** \`${formatMoney(updatedOrder.total_price)}\`\n` +
                `**Recursos:** 🤖 ${snapshot.maxBots} bot(s) · 🧠 ${snapshot.maxRam}MB RAM · ⚡ ${snapshot.maxCpu}% CPU\n\n` +
                `Confira os dados acima. Quando estiver pronto, clique em **Pagar** pra ver os dados do Pix.`
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('commerce_pay').setLabel('Pagar').setEmoji('💳').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('commerce_cancel_order').setLabel('Cancelar Pedido').setEmoji('❌').setStyle(ButtonStyle.Danger)
        );
        return interaction.update({ embeds: [embed], components: [row] });
    }

    if (customId === 'commerce_pay') {
        const order = OrderManager.getOrderByChannel(interaction.channelId);
        if (!order || order.user_id !== interaction.user.id) {
            return interaction.reply({ content: '❌ Pedido não encontrado.', ephemeral: true });
        }
        const payment = PaymentManager.getPaymentByOrder(order.id);
        if (!payment) return interaction.reply({ content: '❌ Selecione um plano antes de pagar.', ephemeral: true });

        const embed = new EmbedBuilder()
            .setColor('#00FF00')
            .setTitle('💳 Pagamento via Pix')
            .setDescription(
                `**Valor:** \`${formatMoney(payment.expected_amount)}\`\n` +
                `**Chave Pix:** \`${payment.pix_key_snapshot || 'Não configurada — avise o suporte'}\`\n` +
                `**Beneficiário:** \`${payment.pix_name_snapshot || 'Atlantic Host'}\`\n` +
                `**Cidade:** \`${payment.pix_city_snapshot || 'São Paulo'}\`\n\n` +
                `Depois de pagar, clique em **Enviar Comprovante**.`
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('commerce_send_proof').setLabel('Enviar Comprovante').setEmoji('📎').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('commerce_cancel_order').setLabel('Cancelar Pedido').setEmoji('❌').setStyle(ButtonStyle.Danger)
        );
        return interaction.update({ embeds: [embed], components: [row] });
    }

    if (customId === 'commerce_send_proof') {
        const order = OrderManager.getOrderByChannel(interaction.channelId);
        if (!order || order.user_id !== interaction.user.id) {
            return interaction.reply({ content: '❌ Pedido não encontrado.', ephemeral: true });
        }

        // Lock síncrono por pedido, checado ANTES de criar o coletor —
        // um clique duplo em "Enviar Comprovante" cria dois
        // MessageCollector independentes no MESMO canal; ambos casam com
        // o mesmo filtro e RECEBEM a mesma mensagem (um collector nunca
        // "consome" a mensagem pro outro), o que chamaria
        // ProofManager.submitProof() duas vezes pro mesmo anexo. Só um
        // coletor ativo por pedido, sempre.
        if (activeProofCollectors.has(order.id)) {
            return interaction.reply({ content: '⏳ Já estamos aguardando seu comprovante — envie o arquivo na mensagem do canal.', ephemeral: true });
        }
        activeProofCollectors.add(order.id);

        await interaction.reply({
            content: `📤 Envie a imagem (JPG/PNG/WEBP) ou PDF do seu comprovante agora (máx. ${Math.round(config.commerce.maxProofSizeBytes / (1024 * 1024))}MB).`,
            ephemeral: true,
        });

        const filter = (m) => m.author.id === interaction.user.id && m.attachments.size > 0;
        const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 300000 });

        collector.on('collect', async (m) => {
            const attachment = m.attachments.first();
            try {
                await ProofManager.submitProof(order.id, interaction.user.id, {
                    url: attachment.url, name: attachment.name, contentType: attachment.contentType, size: attachment.size,
                });

                const embed = new EmbedBuilder()
                    .setColor('#FFFF00')
                    .setTitle('⏳ Comprovante Recebido!')
                    .setDescription('Seu comprovante foi recebido e está aguardando revisão. Você será notificado assim que for analisado.');
                await interaction.channel.send({ embeds: [embed] });

                const cfg = CommerceConfig.getConfig();
                await postToChannel(interaction.guild, cfg?.orders_review_channel_id, {
                    content: `📥 Novo comprovante — pedido #${order.id} de <@${interaction.user.id}> (${formatMoney(OrderManager.getOrder(order.id).total_price)}).`,
                });
            } catch (err) {
                await interaction.channel.send(`❌ ${err.message}`);
            } finally {
                await m.delete().catch(() => {});
            }
        });
        // 'end' sempre dispara (recebeu o máximo OU estourou o tempo) —
        // libera o lock nos dois casos, nunca deixando o pedido travado
        // sem um jeito de tentar de novo.
        collector.on('end', () => {
            activeProofCollectors.delete(order.id);
        });
        return;
    }

    if (customId === 'commerce_cancel_order') {
        const order = OrderManager.getOrderByChannel(interaction.channelId);
        // FASE 10 (correção de bug real): se o pedido existe e pertence a
        // OUTRO usuário, interrompe imediatamente — nunca chama
        // cancelOrder(), nunca responde "Pedido cancelado", nunca agenda
        // exclusão do canal. Antes desta correção, esse caminho caía
        // direto no bloco de sucesso abaixo (só pulava o cancelOrder()),
        // apagando o canal de um pedido que continuava vivo no banco —
        // um efeito parcial real (canal apagado, pedido nunca cancelado).
        if (order && order.user_id !== interaction.user.id) {
            return interaction.reply({ content: '❌ Este pedido não é seu.', ephemeral: true });
        }
        if (order) {
            try {
                OrderManager.cancelOrder(order.id);
            } catch (err) {
                return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
            }
        }
        await interaction.reply({ content: '❌ Pedido cancelado. Este canal será excluído em 5 segundos.' });
        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
        return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // STAFF (revisão de pedidos) — Administrator ou COMMERCE_STAFF ativo
    // ═══════════════════════════════════════════════════════════════════

    if (customId === 'commerce_staff_queue') {
        if (!CommerceStaffManager.hasCommercePermission(interaction.user.id)) {
            return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        }
        const pending = query(
            `SELECT o.*, u.username FROM commerce_orders o JOIN users u ON o.user_id = u.id
             WHERE o.status IN ('PROOF_SUBMITTED','UNDER_REVIEW') ORDER BY o.updated_at ASC`
        );
        if (pending.length === 0) {
            return interaction.reply({ content: '✅ Nenhum pedido aguardando análise no momento.', ephemeral: true });
        }
        const { text: pendingDescription } = buildTruncatedList(
            pending, (o) => `🔹 **#${o.id}** — \`${o.username}\` — \`${formatMoney(o.total_price)}\` (${o.status})`
        );
        const embed = new EmbedBuilder()
            .setColor('#FFFF00')
            .setTitle('📋 Pedidos em Análise')
            .setDescription(pendingDescription);
        const select = new StringSelectMenuBuilder()
            .setCustomId('commerce_staff_select_order')
            .setPlaceholder('Selecione um pedido...')
            .addOptions(pending.slice(0, 25).map((o) => ({ label: `Pedido #${o.id} — ${o.username}`, description: formatMoney(o.total_price), value: String(o.id) })));
        const row = new ActionRowBuilder().addComponents(select);
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (customId === 'commerce_staff_select_order') {
        if (!CommerceStaffManager.hasCommercePermission(interaction.user.id)) {
            return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        }
        const orderId = Number(interaction.values[0]);
        const order = OrderManager.getOrder(orderId);
        if (!order) return interaction.reply({ content: '❌ Pedido não encontrado (já processado?).', ephemeral: true });

        if (order.status === OrderManager.STATUS.PROOF_SUBMITTED) {
            try { PaymentManager.openForReview(order.id, interaction.user.id); } catch { /* outro staff pode ter aberto primeiro — segue exibindo mesmo assim */ }
        }

        const snapshot = order.product_snapshot ? JSON.parse(order.product_snapshot) : null;
        const buyer = get('SELECT username FROM users WHERE id = ?', [order.user_id]);
        // Histórico relevante (Fase 6): quantos comprovantes esse pedido já
        // recebeu no total — cada reenvio (inclusive depois de um "Solicitar
        // Novo Comprovante") preserva a linha anterior, nunca some.
        const proofHistory = ProofManager.listProofsForOrder(order.id);
        const priceLine = order.discount_amount > 0
            ? `**Valor:** \`${formatMoney(order.original_price)}\` → \`${formatMoney(order.total_price)}\` (desconto de \`${formatMoney(order.discount_amount)}\`)`
            : `**Valor:** \`${formatMoney(order.total_price)}\``;
        const embed = new EmbedBuilder()
            .setColor('#FFFF00')
            .setTitle(`🧐 Pedido #${order.id}`)
            .setDescription(
                `**Cliente:** \`${buyer?.username || order.user_id}\` (<@${order.user_id}>)\n` +
                `**Plano:** \`${snapshot?.name || '—'}\`\n` +
                `${priceLine}\n` +
                `**Criado em:** \`${order.created_at}\`\n` +
                `**Status:** \`${order.status}\`\n` +
                `**Comprovantes enviados:** \`${proofHistory.length}\`` +
                (order.rejection_reason ? `\n**Última observação do staff:** ${order.rejection_reason}` : '')
            );
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`commerce_staff_view_proof_${order.id}`).setLabel('Ver Comprovante').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`commerce_staff_approve_${order.id}`).setLabel('Aprovar').setEmoji('✅').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`commerce_staff_request_new_proof_${order.id}`).setLabel('Pedir Novo Comprovante').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`commerce_staff_reject_${order.id}`).setLabel('Recusar').setEmoji('❌').setStyle(ButtonStyle.Danger)
        );
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (customId.startsWith('commerce_staff_view_proof_')) {
        if (!CommerceStaffManager.hasCommercePermission(interaction.user.id)) {
            return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        }
        const orderId = Number(customId.replace('commerce_staff_view_proof_', ''));
        const proof = ProofManager.getLatestProofForOrder(orderId);
        if (!proof) return interaction.reply({ content: '❌ Nenhum comprovante encontrado para este pedido.', ephemeral: true });

        try {
            // getDecryptedProof já audita a visualização e já re-checa
            // permissão internamente — resposta SEMPRE ephemeral, nunca
            // visível a outros clientes/canal público.
            const { buffer, originalFilename } = ProofManager.getDecryptedProof(proof.id, interaction.user.id);
            const attachment = new AttachmentBuilder(buffer, { name: originalFilename || 'comprovante' });
            return interaction.reply({ files: [attachment], ephemeral: true });
        } catch (err) {
            return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
    }

    if (customId.startsWith('commerce_staff_approve_')) {
        if (!CommerceStaffManager.hasCommercePermission(interaction.user.id)) {
            return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        }
        const orderId = Number(customId.replace('commerce_staff_approve_', ''));
        await interaction.deferReply({ ephemeral: true });

        let result;
        try {
            result = PaymentManager.confirmPayment(orderId, interaction.user.id);
        } catch (err) {
            return interaction.editReply({ content: `⚠️ ${err.message}` });
        }

        const order = result.order;
        await notifyBuyer(
            interaction.client, order.user_id,
            `✅ **Seu pagamento foi aprovado!** Pedido #${order.id}.\n` +
            `Seu plano será ativado assim que o provisionamento for concluído — você será avisado.`
        );
        const cfg = CommerceConfig.getConfig();
        await postToChannel(interaction.guild, cfg?.sales_log_channel_id, {
            content: `✅ Pedido #${order.id} aprovado por <@${interaction.user.id}> — \`${formatMoney(order.total_price)}\`${result.couponWarning ? ' ⚠️ cupom acima do limite' : ''}.`,
        });
        await postToChannel(interaction.guild, cfg?.proofs_channel_id, {
            content: `📄 Comprovante do pedido #${order.id} revisado (aceito) por <@${interaction.user.id}>.`,
        });

        const channel = interaction.guild.channels.cache.get(order.channel_id);
        if (channel) {
            await channel.send('✅ **Pagamento Aprovado!** Este canal será fechado em 10 segundos.');
            setTimeout(() => channel.delete().catch(() => {}), 10000);
        }

        // FASE 7: provisionamento automático pós-aprovação, enfileirado —
        // nunca depende da permissão Discord do cliente (o gatilho já foi
        // a aprovação do staff, checada acima por confirmPayment()). Nunca
        // bloqueia a resposta desta interação — o resultado (sucesso ou
        // falha) é tratado de forma assíncrona e notificado separadamente.
        // ProvisioningManager nunca é chamado com um executorUserId aqui —
        // isto É a chamada automática, não um retry manual.
        queueManager.addToQueue(
            () => ProvisioningManager.provision(order.id),
            `Provisionar pedido #${order.id}`
        ).then((provResult) => {
            if (provResult.alreadyActive) return;
            notifyBuyer(
                interaction.client, order.user_id,
                `🎉 **Seu plano foi ativado!** Pedido #${order.id} está pronto — obrigado pela compra.`
            );
        }).catch(async (err) => {
            const cfg2 = CommerceConfig.getConfig();
            await notifyStaffOfImportantFailure(
                interaction.guild, cfg2?.sales_log_channel_id,
                `🚨 **Falha no provisionamento automático** do pedido #${order.id}: ${err.message}\nRequer retry manual — veja "Falhas de Provisionamento" no painel comercial.`
            );
            await notifyBuyer(
                interaction.client, order.user_id,
                `⚠️ **Houve um problema técnico ao ativar seu plano** (Pedido #${order.id}).\n\n` +
                `✅ Seu pagamento continua confirmado.\n` +
                `👥 Nossa equipe de suporte já foi notificada automaticamente.\n` +
                `❌ Você **não precisa pagar novamente**.\n` +
                `⏳ Nenhuma ação é necessária da sua parte agora — vamos resolver e avisar assim que seu plano estiver ativo.`
            );
        });

        return interaction.editReply({ content: `✅ Pedido #${order.id} aprovado com sucesso!${result.couponWarning ? ' ⚠️ cupom acima do limite — verifique.' : ''}` });
    }

    if (customId.startsWith('commerce_staff_reject_')) {
        if (!CommerceStaffManager.hasCommercePermission(interaction.user.id)) {
            return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        }
        const orderId = customId.replace('commerce_staff_reject_', '');
        const modal = new ModalBuilder()
            .setCustomId(`modal_commerce_staff_reject_${orderId}`)
            .setTitle('❌ Recusar Pedido')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('reason').setLabel('Motivo da Recusa').setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Ex: Comprovante inválido ou valor incorreto.').setRequired(true)
            ));
        return interaction.showModal(modal);
    }

    if (customId.startsWith('modal_commerce_staff_reject_')) {
        if (!CommerceStaffManager.hasCommercePermission(interaction.user.id)) {
            return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        }
        const orderId = Number(customId.replace('modal_commerce_staff_reject_', ''));
        const reason = interaction.fields.getTextInputValue('reason');

        let order;
        try {
            order = PaymentManager.rejectPayment(orderId, interaction.user.id, reason);
        } catch (err) {
            return interaction.reply({ content: `⚠️ ${err.message}`, ephemeral: true });
        }

        await notifyBuyer(interaction.client, order.user_id, `❌ **Seu pagamento foi recusado.**\nPedido #${order.id}\n**Motivo:** ${reason}`);
        const cfg = CommerceConfig.getConfig();
        await postToChannel(interaction.guild, cfg?.sales_log_channel_id, { content: `❌ Pedido #${order.id} recusado por <@${interaction.user.id}> — motivo: ${reason}` });
        await postToChannel(interaction.guild, cfg?.proofs_channel_id, { content: `📄 Comprovante do pedido #${order.id} revisado (recusado) por <@${interaction.user.id}>.` });

        const channel = interaction.guild.channels.cache.get(order.channel_id);
        if (channel) {
            await channel.send(`❌ **Pagamento Recusado!**\n**Motivo:** ${reason}\nEste canal será fechado em 10 segundos.`);
            setTimeout(() => channel.delete().catch(() => {}), 10000);
        }
        return interaction.reply({ content: `❌ Pedido #${order.id} recusado.`, ephemeral: true });
    }

    if (customId.startsWith('commerce_staff_request_new_proof_')) {
        if (!CommerceStaffManager.hasCommercePermission(interaction.user.id)) {
            return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        }
        const orderId = customId.replace('commerce_staff_request_new_proof_', '');
        const modal = new ModalBuilder()
            .setCustomId(`modal_commerce_staff_request_new_proof_${orderId}`)
            .setTitle('🔁 Pedir Novo Comprovante')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('reason').setLabel('O que está errado com o comprovante atual?').setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Ex: Comprovante ilegível, valor não confere, precisa enviar de novo.').setRequired(true)
            ));
        return interaction.showModal(modal);
    }

    if (customId.startsWith('modal_commerce_staff_request_new_proof_')) {
        if (!CommerceStaffManager.hasCommercePermission(interaction.user.id)) {
            return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        }
        const orderId = Number(customId.replace('modal_commerce_staff_request_new_proof_', ''));
        const reason = interaction.fields.getTextInputValue('reason');

        // NUNCA rejeição definitiva: UNDER_REVIEW -> NEEDS_NEW_PROOF — o
        // pedido continua vivo, o Payment continua AWAITING_PROOF (nenhuma
        // decisão financeira foi tomada), só se pediu uma evidência melhor.
        let order;
        try {
            order = PaymentManager.requestNewProof(orderId, interaction.user.id, reason);
        } catch (err) {
            return interaction.reply({ content: `⚠️ ${err.message}`, ephemeral: true });
        }

        const cfg = CommerceConfig.getConfig();
        await postToChannel(interaction.guild, cfg?.sales_log_channel_id, { content: `🔁 Pedido #${order.id}: novo comprovante solicitado por <@${interaction.user.id}> — motivo: ${reason}` });

        const channel = interaction.guild.channels.cache.get(order.channel_id);
        if (channel) {
            const embed = new EmbedBuilder()
                .setColor('#FFAA00')
                .setTitle('🔁 Precisamos de um novo comprovante')
                .setDescription(`**Motivo:** ${reason}\n\nClique no botão abaixo e envie um comprovante novo.`);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('commerce_send_proof').setLabel('Enviar Comprovante').setEmoji('📎').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('commerce_cancel_order').setLabel('Cancelar Pedido').setEmoji('❌').setStyle(ButtonStyle.Danger)
            );
            await channel.send({ content: `<@${order.user_id}>`, embeds: [embed], components: [row] });
        }
        await notifyBuyer(interaction.client, order.user_id, `🔁 **Precisamos de um novo comprovante** pro seu pedido #${order.id}.\n**Motivo:** ${reason}\nAcesse o canal do seu pedido pra enviar.`);

        return interaction.reply({ content: `🔁 Pedido #${order.id}: novo comprovante solicitado ao cliente.`, ephemeral: true });
    }

    // FASE 7: listagem dedicada de pedidos com pagamento confirmado mas
    // provisionamento não concluído — Payment continua 'confirmed' nesses
    // casos (nunca cancelado automaticamente), só falta o retry.
    if (customId === 'commerce_staff_provisioning_failures') {
        if (!CommerceStaffManager.hasCommercePermission(interaction.user.id)) {
            return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        }
        const failed = query(
            `SELECT o.*, u.username FROM commerce_orders o JOIN users u ON o.user_id = u.id
             WHERE o.status = 'PROVISIONING_FAILED' ORDER BY o.updated_at ASC`
        );
        if (failed.length === 0) {
            return interaction.reply({ content: '✅ Nenhuma falha de provisionamento pendente no momento.', ephemeral: true });
        }
        const { text: failedDescription } = buildTruncatedList(
            failed, (o) => `🔹 **#${o.id}** — \`${o.username}\` — \`${formatMoney(o.total_price)}\``
        );
        const embed = new EmbedBuilder()
            .setColor('#FF5555')
            .setTitle('🚨 Falhas de Provisionamento')
            .setDescription(failedDescription);
        const buttons = failed.slice(0, 5).map((o) =>
            new ButtonBuilder().setCustomId(`commerce_staff_retry_provisioning_${o.id}`).setLabel(`Retry #${o.id}`).setEmoji('🔄').setStyle(ButtonStyle.Primary)
        );
        // Discord permite no máximo 5 botões por linha — pedidos além
        // disso continuam visíveis na lista, só sem botão de retry direto
        // nesta resposta (o comando pode ser reaberto depois que os
        // primeiros forem resolvidos).
        const row = new ActionRowBuilder().addComponents(buttons);
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (customId.startsWith('commerce_staff_retry_provisioning_')) {
        if (!CommerceStaffManager.hasCommercePermission(interaction.user.id)) {
            return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        }
        const orderId = Number(customId.replace('commerce_staff_retry_provisioning_', ''));
        await interaction.deferReply({ ephemeral: true });

        try {
            const result = ProvisioningManager.provision(orderId, { executorUserId: interaction.user.id });
            if (!result.alreadyActive) {
                await notifyBuyer(
                    interaction.client, result.order.user_id,
                    `🎉 **Seu plano foi ativado!** Pedido #${result.order.id} está pronto — obrigado pela paciência.`
                );
            }
            const cfg = CommerceConfig.getConfig();
            await postToChannel(interaction.guild, cfg?.sales_log_channel_id, {
                content: `✅ Retry de provisionamento do pedido #${orderId} concluído com sucesso por <@${interaction.user.id}>.`,
            });
            return interaction.editReply({ content: `✅ Pedido #${orderId} provisionado com sucesso.` });
        } catch (err) {
            return interaction.editReply({ content: `⚠️ Retry falhou: ${err.message}` });
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // ADMIN (produtos, Pix, estatísticas, auditoria) — só Administrator
    // ═══════════════════════════════════════════════════════════════════

    if (customId === 'commerce_admin_products') {
        if (!hasPermission(interaction.user.id, 'admin')) return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });

        const products = ProductCatalog.getAllProducts();
        const embed = new EmbedBuilder()
            .setColor('#FFAA00')
            .setTitle('📦 Produtos')
            .setDescription(products.length ? products.map((p) => `\`${p.status}\` **${p.name}** — ${formatMoney(p.price)} (\`${p.id}\`)`).join('\n') : 'Nenhum produto cadastrado.');
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('commerce_admin_create_product').setLabel('Criar Produto').setEmoji('➕').setStyle(ButtonStyle.Success)
        );
        const components = [row];
        if (products.length) {
            const select = new StringSelectMenuBuilder()
                .setCustomId('commerce_admin_select_product')
                .setPlaceholder('Selecione um produto pra gerenciar...')
                .addOptions(products.slice(0, 25).map((p) => ({ label: `${p.name} (${p.status})`, description: formatMoney(p.price), value: p.id })));
            components.unshift(new ActionRowBuilder().addComponents(select));
        }
        return interaction.reply({ embeds: [embed], components, ephemeral: true });
    }

    if (customId === 'commerce_admin_create_product') {
        if (!hasPermission(interaction.user.id, 'admin')) return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        const modal = new ModalBuilder()
            .setCustomId('modal_commerce_admin_create_product')
            .setTitle('➕ Criar Produto')
            .addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('id').setLabel('ID interno (único, sem espaços)').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('Nome').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('price').setLabel('Preço mensal (ex: 29.90)').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('resources').setLabel('Bots,RAM(MB),CPU(%) — ex: 2,512,40').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Descrição (opcional)').setStyle(TextInputStyle.Paragraph).setRequired(false))
            );
        return interaction.showModal(modal);
    }

    if (customId === 'modal_commerce_admin_create_product') {
        if (!hasPermission(interaction.user.id, 'admin')) return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        const id = interaction.fields.getTextInputValue('id').trim().toLowerCase().replace(/\s+/g, '-');
        const name = interaction.fields.getTextInputValue('name').trim();
        const price = parseFloat(interaction.fields.getTextInputValue('price').replace(',', '.'));
        const [maxBots, maxRam, maxCpu] = interaction.fields.getTextInputValue('resources').split(',').map((v) => parseInt(v.trim(), 10));
        const description = interaction.fields.getTextInputValue('description') || null;

        // FASE 10 (correção de bug real): antes, só validava
        // Number.isFinite — um valor negativo (ex.: "-5,512,40") passava
        // essa checagem e seguia pra saveProduct(), que só rejeita specs
        // ACIMA do teto do host (Fase 9), nunca abaixo de zero. Um produto
        // com capacidade negativa salvava normalmente e, numa venda real,
        // escreveria users.max_bots/max_ram/max_cpu negativos.
        if (
            !Number.isFinite(price) || price < 0
            || ![maxBots, maxRam, maxCpu].every((v) => Number.isFinite(v) && v >= 0)
        ) {
            return interaction.reply({ content: '❌ Valores inválidos — preço e recursos (bots, RAM, CPU) precisam ser números válidos e nunca negativos.', ephemeral: true });
        }

        try {
            const product = ProductCatalog.saveProduct({ id, name, price, maxBots, maxRam, maxCpu, description });
            return interaction.reply({ content: `✅ Produto \`${product.id}\` criado como **rascunho**. Publique-o em "Produtos" quando estiver pronto.`, ephemeral: true });
        } catch (err) {
            return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
    }

    if (customId === 'commerce_admin_select_product') {
        if (!hasPermission(interaction.user.id, 'admin')) return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        const productId = interaction.values[0];
        const product = ProductCatalog.getProduct(productId);
        if (!product) return interaction.reply({ content: '❌ Produto não encontrado.', ephemeral: true });

        const embed = new EmbedBuilder()
            .setColor('#FFAA00')
            .setTitle(`📦 ${product.name}`)
            .setDescription(
                `**Status:** \`${product.status}\`\n**Preço:** \`${formatMoney(product.price)}/mês\`\n` +
                `**Recursos:** 🤖 ${product.max_bots} · 🧠 ${product.max_ram}MB · ⚡ ${product.max_cpu}%\n` +
                (product.description ? `**Descrição:** ${product.description}\n` : '')
            );

        const buttons = [];
        if ([ProductCatalog.PRODUCT_STATUS.DRAFT, ProductCatalog.PRODUCT_STATUS.PAUSED].includes(product.status)) {
            buttons.push(new ButtonBuilder().setCustomId(`commerce_admin_publish_product_${product.id}`).setLabel('Publicar').setEmoji('🚀').setStyle(ButtonStyle.Success));
        }
        if (product.status === ProductCatalog.PRODUCT_STATUS.PUBLISHED) {
            buttons.push(new ButtonBuilder().setCustomId(`commerce_admin_pause_product_${product.id}`).setLabel('Pausar').setEmoji('⏸️').setStyle(ButtonStyle.Secondary));
        }
        if (product.status !== ProductCatalog.PRODUCT_STATUS.ARCHIVED) {
            buttons.push(new ButtonBuilder().setCustomId(`commerce_admin_archive_product_${product.id}`).setLabel('Arquivar').setEmoji('🗄️').setStyle(ButtonStyle.Danger));
        }
        const row = new ActionRowBuilder().addComponents(buttons);
        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    if (customId.startsWith('commerce_admin_publish_product_') || customId.startsWith('commerce_admin_pause_product_') || customId.startsWith('commerce_admin_archive_product_')) {
        if (!hasPermission(interaction.user.id, 'admin')) return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });

        let productIdParsed, fn, label;
        if (customId.startsWith('commerce_admin_publish_product_')) {
            productIdParsed = customId.replace('commerce_admin_publish_product_', ''); fn = ProductCatalog.publishProduct; label = 'publicado';
        } else if (customId.startsWith('commerce_admin_pause_product_')) {
            productIdParsed = customId.replace('commerce_admin_pause_product_', ''); fn = ProductCatalog.pauseProduct; label = 'pausado';
        } else {
            productIdParsed = customId.replace('commerce_admin_archive_product_', ''); fn = ProductCatalog.archiveProduct; label = 'arquivado';
        }

        try {
            const product = fn(productIdParsed);
            return interaction.reply({ content: `✅ Produto \`${product.id}\` ${label}.`, ephemeral: true });
        } catch (err) {
            return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
        }
    }

    if (customId === 'commerce_admin_config_pix') {
        if (!hasPermission(interaction.user.id, 'admin')) return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        const modal = new ModalBuilder()
            .setCustomId('modal_commerce_admin_config_pix')
            .setTitle('💰 Configurar Pix')
            .addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pix_key').setLabel('Chave Pix').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pix_name').setLabel('Nome do beneficiário').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pix_city').setLabel('Cidade').setStyle(TextInputStyle.Short).setRequired(true))
            );
        return interaction.showModal(modal);
    }

    if (customId === 'modal_commerce_admin_config_pix') {
        if (!hasPermission(interaction.user.id, 'admin')) return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        const pixKey = interaction.fields.getTextInputValue('pix_key').trim();
        const pixName = interaction.fields.getTextInputValue('pix_name').trim();
        const pixCity = interaction.fields.getTextInputValue('pix_city').trim();

        run('UPDATE sales_config SET pix_key = ?, pix_name = ?, pix_city = ? WHERE id = 1', [pixKey, pixName, pixCity]);
        // Auditoria SEM o valor da chave — só o fato de que foi alterada e
        // por quem (nunca colocar segredo/dado sensível em log — a chave
        // Pix do beneficiário não é um "segredo" no sentido de token, mas
        // é dado financeiro; tratamos com a mesma cautela por padrão).
        const { recordAuditEvent } = require('../../managers/auditManager');
        recordAuditEvent({ userId: interaction.user.id, event: 'commerce:pix_configured', details: JSON.stringify({ configuredBy: interaction.user.id }), severity: 'info' });

        return interaction.reply({ content: '✅ Dados Pix atualizados.', ephemeral: true });
    }

    if (customId === 'commerce_admin_stats') {
        if (!hasPermission(interaction.user.id, 'admin')) return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });

        const counts = {};
        for (const status of Object.values(OrderManager.STATUS)) {
            counts[status] = get('SELECT COUNT(*) as c FROM commerce_orders WHERE status = ?', [status]).c;
        }
        const monthRevenue = get(
            `SELECT COALESCE(SUM(total_price),0) as total FROM commerce_orders WHERE status IN ('APPROVED','PROVISIONING','ACTIVE') AND strftime('%Y-%m', updated_at) = strftime('%Y-%m','now')`
        ).total;
        const activeEntitlements = get("SELECT COUNT(*) as c FROM commerce_entitlements WHERE status = 'active'").c;

        const embed = new EmbedBuilder()
            .setColor('#00AAFF')
            .setTitle('📈 Estatísticas Comerciais')
            .setDescription(
                Object.entries(counts).map(([status, c]) => `\`${status}\`: ${c}`).join('\n') +
                `\n\n**Faturamento aprovado este mês:** ${formatMoney(monthRevenue)}\n` +
                `**Entitlements ativos:** ${activeEntitlements}`
            );
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (customId === 'commerce_admin_audit') {
        if (!hasPermission(interaction.user.id, 'admin')) return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true });
        const recent = query("SELECT * FROM audit_log WHERE action LIKE 'commerce:%' ORDER BY id DESC LIMIT 15");
        const embed = new EmbedBuilder()
            .setColor('#FFAA00')
            .setTitle('🧾 Auditoria Comercial (últimos 15 eventos)')
            .setDescription(recent.length ? recent.map((e) => `\`${e.created_at}\` **${e.action}**`).join('\n') : 'Nenhum evento registrado ainda.');
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    return true;
}

module.exports = { match, handle, publishStorefront, publishStaffPanel };
