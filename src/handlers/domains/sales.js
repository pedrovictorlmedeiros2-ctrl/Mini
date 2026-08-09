/**
 * DOMÍNIO: SALES
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

const { hasPermission, getUser, registerUser } = require('../../managers/userManager');
const { logSecurityEvent, logAction } = require('../../managers/logManager');
const { checkRateLimit, formatRetryAfter } = require('../../utils/rateLimiter');

const { createOrder, getOrderByChannel, updateOrderPlan, applyCouponToOrder, updateOrderStatus } = require('../../managers/orderManager');
const { validateCoupon, incrementCouponUse, createCoupon } = require('../../managers/couponManager');
const { canAddBot, getUserPlanInfo, getAllPlans, getPlan } = require('../../managers/planManager');

const EXACT = ['sales_buy_plan', 'sales_select_plan', 'sales_plan_choice', 'sales_view_plans', 'sales_apply_coupon_global', 'sales_apply_coupon', 'modal_sales_apply_coupon', 'sales_pay', 'sales_send_receipt', 'sales_cancel_order'];
const PREFIXES = ['modal_sales_'];

function match(customId) {
    if (EXACT.includes(customId)) return true;
    return PREFIXES.some(p => customId.startsWith(p));
}

async function handle(interaction, helpers = {}) {
    const customId = interaction.customId;
    // helpers opcionais (compat)

if (customId === 'sales_buy_plan') {
    // CORREÇÃO: quem nunca rodou /painel antes não tinha registro na tabela
    // users — e orders.user_id tem FOREIGN KEY pra users(id), então criar
    // carrinho quebrava com "FOREIGN KEY constraint failed" antes mesmo de
    // chegar na tela de compra. registerUser é idempotente (não duplica se
    // já existir), então é seguro chamar sempre aqui.
    registerUser(interaction.user);

    // Verifica se o usuário já tem um carrinho aberto
    const existingOrder = get("SELECT channel_id FROM orders WHERE user_id = ? AND status IN ('pending', 'waiting_payment', 'in_analysis')", [interaction.user.id]);
    if (existingOrder) {
        return interaction.reply({ content: `❌ Você já possui um carrinho aberto: <#${existingOrder.channel_id}>`, ephemeral: true });
    }

    // Defesa em profundidade: mesmo com o bloqueio de carrinho único acima,
    // um script podia abrir e cancelar repetidamente pra criar/apagar
    // canais em sequência (churn na API do Discord). 10 carrinhos/hora.
    const cartLimit = checkRateLimit(`cart:${interaction.user.id}`, 10, 60 * 60 * 1000);
    if (!cartLimit.allowed) {
        return interaction.reply({ content: `${config.emojis.error} Muitos carrinhos criados recentemente. Tente novamente em ${formatRetryAfter(cartLimit.retryAfterMs)}.`, ephemeral: true });
    }

    await interaction.reply({ content: '⏳ Criando seu carrinho...', ephemeral: true });

    // Declarado fora do try/catch de propósito: se o canal for criado com
    // sucesso mas um passo DEPOIS falhar (ex: erro no banco), o catch
    // precisa enxergar essa variável pra poder limpar o canal órfão.
    let channel;
    try {
        const guild = interaction.guild;
        const salesConfig = get('SELECT category_id, admin_role_id FROM sales_config WHERE id = 1');

        // CORREÇÃO: o canal do carrinho não dava acesso nenhum à equipe de
        // suporte (admin_role_id, configurado especificamente pra isso no
        // painel de vendas, nunca era usado aqui) — só o próprio comprador
        // enxergava o canal. Também não usava a categoria configurada.
        const permissionOverwrites = [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        ];
        if (salesConfig?.admin_role_id) {
            permissionOverwrites.push({
                id: salesConfig.admin_role_id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
            });
        }

        channel = await guild.channels.create({
            name: `carrinho-${interaction.user.username}`,
            type: ChannelType.GuildText,
            parent: salesConfig?.category_id || undefined,
            permissionOverwrites,
        });

        const order = createOrder(interaction.user.id, channel.id);
        

        logAction(null, interaction.user.id, 'CREATE_CART', `Abriu um carrinho de compras: ${channel.name}`);

        const embed = new EmbedBuilder()
            .setColor('#00AAFF')
            .setTitle('🛒 Seu Carrinho')
            .setDescription(
                `Olá ${interaction.user}, bem-vindo ao seu carrinho!\n\n` +
                `**Plano:** \`Nenhum selecionado\`\n` +
                `**Valor:** \`R$ 0,00\`\n` +
                `**Status:** \`Aguardando seleção de plano\``
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('sales_select_plan').setLabel('Selecionar Plano').setEmoji('📋').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('sales_cancel_order').setLabel('Cancelar Pedido').setEmoji('❌').setStyle(ButtonStyle.Danger)
        );

        await channel.send({ content: `${interaction.user}`, embeds: [embed], components: [row] });
        await interaction.editReply({ content: `✅ Carrinho criado com sucesso: ${channel}` });
    } catch (err) {
        console.error('❌ Erro ao criar carrinho:', err);
        // CORREÇÃO: se o canal já tinha sido criado no Discord antes do erro
        // (ex: falha no banco depois), ele ficava órfão — sem pedido
        // correspondente e sem ninguém saber que existe. Limpa se possível.
        if (channel?.deletable) {
            try { await channel.delete('Erro ao criar pedido — limpeza automática'); } catch { /* Ignora */ }
        }
        await interaction.editReply({ content: '❌ Erro ao criar seu carrinho. Tente novamente ou avise a equipe de suporte.' });
    }
}

else if (customId === 'sales_select_plan') {
    const plans = getAllPlans();
    if (plans.length === 0) {
        return interaction.reply({ content: '❌ Nenhum plano disponível no momento.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#00AAFF')
        .setTitle('📋 Planos Disponíveis')
        .setDescription('Escolha o plano que melhor atende às suas necessidades:');

    const select = new StringSelectMenuBuilder()
        .setCustomId('sales_plan_choice')
        .setPlaceholder('Selecione um plano...')
        .addOptions(plans.map(p => ({
            label: p.name,
            description: `R$ ${p.price.toFixed(2)} | ${p.max_bots} Bot(s) | ${p.max_ram}MB RAM`,
            value: p.id
        })));

    const row = new ActionRowBuilder().addComponents(select);
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

else if (customId === 'sales_plan_choice') {
    const planId = interaction.values[0];
    const order = getOrderByChannel(interaction.channelId);
    if (!order) return interaction.reply({ content: '❌ Pedido não encontrado.', ephemeral: true });

    updateOrderPlan(order.id, planId);
    const plan = getPlan(planId);

    const embed = new EmbedBuilder()
        .setColor(plan.color || '#00AAFF')
        .setTitle('🛒 Seu Carrinho - Plano Selecionado')
        .setDescription(
            `**Plano:** \`${plan.name}\`\n` +
            `**Valor:** \`R$ ${plan.price.toFixed(2)}\`\n` +
            `**Recursos:**\n` +
            `> 🤖 ${plan.max_bots} Bot(s)\n` +
            `> 🧠 ${plan.max_ram}MB RAM\n` +
            `> ⚡ ${plan.max_cpu}% CPU\n\n` +
            `**Status:** \`Aguardando pagamento\``
        );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sales_pay').setLabel('Pagar').setEmoji('💳').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('sales_apply_coupon').setLabel('Inserir Cupom').setEmoji('🎟').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('sales_select_plan').setLabel('Mudar Plano').setEmoji('📋').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('sales_cancel_order').setLabel('Cancelar Pedido').setEmoji('❌').setStyle(ButtonStyle.Danger)
    );

    await interaction.update({ embeds: [embed], components: [row] });
}

// CORREÇÃO: os botões "Ver Planos" e "Aplicar Cupom" do painel público de
// vendas (/criar-painel-vendas) eram criados em painel.js mas não tinham
// handler nenhum aqui — clicar neles resultava em "Esta interação falhou"
// no Discord, sem nenhuma resposta. Implementados abaixo.
else if (customId === 'sales_view_plans') {
    const plans = getAllPlans();
    if (plans.length === 0) {
        return interaction.reply({ content: '❌ Nenhum plano disponível no momento.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#00AAFF')
        .setTitle('📋 Planos Disponíveis')
        .setDescription(
            plans.map(p =>
                `**${p.name}** — \`R$ ${p.price.toFixed(2)}\`\n` +
                `> 🤖 ${p.max_bots} Bot(s) | 🧠 ${p.max_ram}MB RAM | ⚡ ${p.max_cpu}% CPU`
            ).join('\n\n')
        )
        .setFooter({ text: 'Clique em "Comprar Plano" para abrir seu carrinho.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sales_buy_plan').setLabel('Comprar Plano').setEmoji('🛒').setStyle(ButtonStyle.Success)
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

else if (customId === 'sales_apply_coupon_global') {
    // Cupons só existem no contexto de um pedido (carrinho) já aberto —
    // não há onde persistir um desconto "solto" sem uma order associada.
    const existingOrder = get("SELECT channel_id FROM orders WHERE user_id = ? AND status IN ('pending', 'waiting_payment', 'in_analysis')", [interaction.user.id]);

    if (existingOrder) {
        return interaction.reply({ content: `🎟 Você já tem um carrinho aberto em <#${existingOrder.channel_id}> — use o botão "Inserir Cupom" por lá.`, ephemeral: true });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sales_buy_plan').setLabel('Comprar Plano').setEmoji('🛒').setStyle(ButtonStyle.Success)
    );
    await interaction.reply({
        content: '🎟 Para aplicar um cupom, primeiro abra um carrinho e selecione um plano — o botão "Inserir Cupom" aparece dentro dele.',
        components: [row],
        ephemeral: true,
    });
}

else if (customId === 'sales_apply_coupon') {
    const modal = new ModalBuilder()
        .setCustomId('modal_sales_apply_coupon')
        .setTitle('🎟 Aplicar Cupom')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('coupon_code')
                    .setLabel('Código do Cupom')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('EX: WELCOME10')
                    .setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId === 'modal_sales_apply_coupon') {
    const code = interaction.fields.getTextInputValue('coupon_code').trim().toUpperCase();
    const order = getOrderByChannel(interaction.channelId);
    if (!order) return interaction.reply({ content: '❌ Pedido não encontrado.', ephemeral: true });

    // Sem limite, dava pra tentar dezenas de códigos de cupom em minutos
    // (brute-force de código de desconto). 8 tentativas a cada 10min/usuário.
    const couponLimit = checkRateLimit(`coupon:${interaction.user.id}`, 8, 10 * 60 * 1000);
    if (!couponLimit.allowed) {
        return interaction.reply({ content: `${config.emojis.error} Muitas tentativas de cupom. Tente novamente em ${formatRetryAfter(couponLimit.retryAfterMs)}.`, ephemeral: true });
    }

    try {
        const coupon = validateCoupon(code);
        applyCouponToOrder(order.id, coupon);

        const updatedOrder = getOrderByChannel(interaction.channelId);
        const plan = getPlan(updatedOrder.plan_id);

        const embed = new EmbedBuilder()
            .setColor(plan.color || '#00AAFF')
            .setTitle('🛒 Seu Carrinho - Cupom Aplicado!')
            .setDescription(
                `**Plano:** \`${plan.name}\`\n` +
                `**Valor Original:** \`R$ ${updatedOrder.original_price.toFixed(2)}\`\n` +
                `**Desconto:** \`R$ ${updatedOrder.discount_amount.toFixed(2)}\` (\`${code}\`)\n` +
                `**Total a Pagar:** \`R$ ${updatedOrder.total_price.toFixed(2)}\`\n\n` +
                `**Status:** \`Aguardando pagamento\``
            );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('sales_pay').setLabel('Pagar').setEmoji('💳').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('sales_select_plan').setLabel('Mudar Plano').setEmoji('📋').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('sales_cancel_order').setLabel('Cancelar Pedido').setEmoji('❌').setStyle(ButtonStyle.Danger)
        );

        await interaction.update({ embeds: [embed], components: [row] });
    } catch (err) {
        await interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
}

else if (customId === 'sales_pay') {
    const order = getOrderByChannel(interaction.channelId);
    if (!order || !order.plan_id) return interaction.reply({ content: '❌ Selecione um plano antes de pagar.', ephemeral: true });

    const configPix = get("SELECT * FROM sales_config WHERE id = 1");
    
    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('💳 Pagamento via Pix')
        .setDescription(
            `Para ativar seu plano, realize o pagamento abaixo:\n\n` +
            `**Valor:** \`R$ ${order.total_price.toFixed(2)}\`\n` +
            `**Chave Pix:** \`${configPix.pix_key || 'Não configurada'}\`\n` +
            `**Beneficiário:** \`${configPix.pix_name || 'Atlantic Host'}\`\n` +
            `**Cidade:** \`${configPix.pix_city || 'São Paulo'}\`\n\n` +
            `Após realizar o pagamento, clique no botão abaixo para enviar o comprovante.`
        );

    if (configPix.pix_qrcode) {
        embed.setImage(configPix.pix_qrcode);
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sales_send_receipt').setLabel('Enviar Comprovante').setEmoji('📎').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('sales_cancel_order').setLabel('Cancelar Pedido').setEmoji('❌').setStyle(ButtonStyle.Danger)
    );

    await interaction.update({ embeds: [embed], components: [row] });
}

else if (customId === 'sales_send_receipt') {
    await interaction.reply({ content: '📤 Por favor, envie a imagem ou PDF do seu comprovante agora.', ephemeral: true });
    
    const filter = m => m.author.id === interaction.user.id && m.attachments.size > 0;
    const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 300000 });

    collector.on('collect', async m => {
        const attachment = m.attachments.first();
        const order = getOrderByChannel(interaction.channelId);
        if (!order) return;

        // CORREÇÃO: attachment.url do Discord é uma URL ASSINADA que expira
        // (~24h). Guardar ela direto no banco para usar depois (quando o
        // admin for aprovar, possivelmente dias depois) quebrava a imagem
        // do comprovante. Agora baixamos o arquivo pro disco e servimos ele
        // localmente quando o admin revisar o pedido.
        let receiptPath = null;
        try {
            fs.mkdirSync(path.resolve(config.system.receiptsFolder), { recursive: true });
            const ext = path.extname(attachment.name) || '.bin';
            receiptPath = path.join(path.resolve(config.system.receiptsFolder), `${order.id}${ext}`);
            const res = await fetch(attachment.url);
            if (res.ok) {
                fs.writeFileSync(receiptPath, Buffer.from(await res.arrayBuffer()));
            } else {
                receiptPath = null;
            }
        } catch {
            receiptPath = null;
        }

        // Se por algum motivo o download falhar, ainda guardamos a URL
        // original como fallback (melhor que nada, mesmo que possa expirar).
        updateOrderStatus(order.id, 'in_analysis', { receipt_url: receiptPath || attachment.url });

        const embed = new EmbedBuilder()
            .setColor('#FFFF00')
            .setTitle('⏳ Comprovante Enviado!')
            .setDescription(
                'Seu comprovante foi recebido e está em análise.\n' +
                'Nossa equipe validará o pagamento em breve e seu plano será ativado automaticamente.'
            );

        await interaction.channel.send({ embeds: [embed] });
        await m.delete().catch(() => {});
    });
}

else if (customId === 'sales_cancel_order') {
    const order = getOrderByChannel(interaction.channelId);
    if (order) {
        updateOrderStatus(order.id, 'cancelled');
    }
    await interaction.reply({ content: '❌ Pedido cancelado. Este canal será excluído em 5 segundos.' });
    setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
}

// ======================================================================
// PAINEL ADMINISTRATIVO DE VENDAS
// ======================================================================

    return true;
}

module.exports = { match, handle };
