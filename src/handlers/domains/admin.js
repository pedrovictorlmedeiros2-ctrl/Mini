/**
 * DOMÍNIO: ADMIN
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
const { canAddBot, getUserPlanInfo, getAllPlans, getPlan, activateUserPlan, savePlan } = require('../../managers/planManager');

const EXACT = ['admin_view_orders', 'admin_order_select', 'admin_config_pix', 'modal_admin_config_pix', 'admin_stats', 'admin_settings', 'admin_security_logs', 'admin_manage_plans', 'modal_admin_add_plan', 'admin_set_user_plan', 'modal_admin_set_user_plan', 'admin_set_user_role', 'modal_admin_set_user_role', 'admin_manage_coupons', 'modal_admin_add_coupon'];
const PREFIXES = ['admin_approve_', 'admin_reject_', 'modal_admin_'];

function match(customId) {
    if (EXACT.includes(customId)) return true;
    return PREFIXES.some(p => customId.startsWith(p));
}

async function handle(interaction, helpers = {}) {
    const customId = interaction.customId;
    // helpers opcionais (compat)

if (customId === 'admin_view_orders') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const pendingOrders = query("SELECT o.*, u.username FROM orders o JOIN users u ON o.user_id = u.id WHERE o.status = 'in_analysis' ORDER BY o.updated_at ASC");
    
    if (pendingOrders.length === 0) {
        return interaction.reply({ content: '✅ Nenhum pedido aguardando análise no momento.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor('#FFFF00')
        .setTitle('📋 Pedidos em Análise')
        .setDescription(pendingOrders.map(o => `🔹 **ID:** \`${o.id}\` | **Usuário:** \`${o.username}\` | **Valor:** \`R$ ${o.total_price.toFixed(2)}\``).join('\n'));

    const select = new StringSelectMenuBuilder()
        .setCustomId('admin_order_select')
        .setPlaceholder('Selecione um pedido para analisar...')
        .addOptions(pendingOrders.slice(0, 25).map(o => ({
            label: `Pedido #${o.id} - ${o.username}`,
            description: `Valor: R$ ${o.total_price.toFixed(2)}`,
            value: o.id.toString()
        })));

    const row = new ActionRowBuilder().addComponents(select);
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

else if (customId === 'admin_order_select') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const orderId = interaction.values[0];
    const order = get("SELECT o.*, u.username, p.name as plan_name FROM orders o JOIN users u ON o.user_id = u.id JOIN plans p ON o.plan_id = p.id WHERE o.id = ?", [orderId]);
    if (!order) return interaction.reply({ content: 'Pedido não encontrado (talvez já tenha sido processado).', ephemeral: true });

    const embed = new EmbedBuilder()
        .setColor('#FFFF00')
        .setTitle(`🧐 Analisando Pedido #${orderId}`)
        .setDescription(
            `**Cliente:** \`${order.username}\` (<@${order.user_id}>)\n` +
            `**Plano:** \`${order.plan_name}\`\n` +
            `**Valor Total:** \`R$ ${order.total_price.toFixed(2)}\`\n` +
            `**Status:** \`Em Análise\``
        );

    // CORREÇÃO: receipt_url agora pode ser um caminho de arquivo LOCAL
    // (baixado no momento do envio, veja sales_send_receipt) ou, em casos
    // raros de fallback, uma URL do Discord que pode já ter expirado.
    const files = [];
    const isLocalFile = order.receipt_url && fs.existsSync(order.receipt_url);
    if (isLocalFile) {
        const receiptName = `comprovante${path.extname(order.receipt_url)}`;
        files.push(new AttachmentBuilder(order.receipt_url, { name: receiptName }));
        embed.setImage(`attachment://${receiptName}`);
    } else if (order.receipt_url) {
        embed.setImage(order.receipt_url);
    }

    const components = [
        new ButtonBuilder().setCustomId(`admin_approve_${orderId}`).setLabel('Aprovar').setEmoji('✅').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`admin_reject_${orderId}`).setLabel('Recusar').setEmoji('❌').setStyle(ButtonStyle.Danger)
    ];
    // O botão de link só funciona com uma URL http(s) de verdade — um
    // caminho de arquivo local (o caso normal agora) quebraria o botão.
    if (order.receipt_url && !isLocalFile) {
        components.push(new ButtonBuilder().setLabel('Ver Comprovante').setEmoji('🔍').setURL(order.receipt_url).setStyle(ButtonStyle.Link));
    }
    const row = new ActionRowBuilder().addComponents(components);

    await interaction.update({ embeds: [embed], components: [row], files });
}

else if (customId.startsWith('admin_approve_')) {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const orderId = customId.replace('admin_approve_', '');
    const order = get("SELECT o.*, p.name as plan_name FROM orders o LEFT JOIN plans p ON o.plan_id = p.id WHERE o.id = ?", [orderId]);
    if (!order) return interaction.reply({ content: 'Pedido não encontrado.', ephemeral: true });
    // CORREÇÃO (bug financeiro — processamento duplicado): nada impedia que este
    // pedido fosse aprovado mais de uma vez (ex: admin clicando 2x rápido, ou
    // dois admins analisando o mesmo pedido ao mesmo tempo). Isso pagava a
    // comissão de afiliado em dobro, incrementava o cupom duas vezes e reenviava
    // notificações. Agora só processa se o pedido ainda estiver 'in_analysis'.
    if (order.status !== 'in_analysis') {
        return interaction.reply({ content: `⚠️ Este pedido já foi processado (status atual: \`${order.status}\`). Nenhuma ação foi executada.`, ephemeral: true });
    }
    // Trava o pedido IMEDIATAMENTE (ainda de forma síncrona, antes de qualquer
    // await) para fechar a janela de corrida entre dois cliques quase
    // simultâneos no botão Aprovar.
    updateOrderStatus(orderId, 'processing');

    await interaction.deferReply({ ephemeral: true });

    try {
        const { activateUserPlan } = require('../../managers/planManager');
        const { incrementCouponUse } = require('../../managers/couponManager');

        // 1. Ativa o plano
        await activateUserPlan(order.user_id, order.plan_id, interaction.client, interaction.guild);

        // 2. Incrementa uso do cupom (se houver)
        // CORREÇÃO (bug de negócio — vazamento de limite de cupom):
        // o cupom só era validado uma vez em 'apply to cart', na hora de
        // montar o pedido. Como pedidos ficam em 'in_analysis' aguardando
        // aprovação manual, VÁRIOS clientes podiam aplicar o mesmo cupom
        // de uso único ao carrinho antes de qualquer aprovação — e todos
        // seriam aprovados, estourando max_uses sem qualquer aviso. Agora
        // revalidamos o limite aqui, no momento em que o uso é de fato
        // confirmado, e avisamos o admin se o cupom já tiver estourado
        // (sem bloquear a ativação do plano, já que o pagamento já foi
        // manualmente confirmado pelo admin).
        let couponWarning = '';
        if (order.coupon_id) {
            const coupon = get('SELECT * FROM coupons WHERE id = ?', [order.coupon_id]);
            if (coupon && coupon.max_uses > 0 && coupon.current_uses >= coupon.max_uses) {
                couponWarning = `\n⚠️ Atenção: o cupom \`${coupon.code}\` já havia atingido o limite de usos (${coupon.current_uses}/${coupon.max_uses}) antes desta aprovação. O plano foi ativado normalmente, mas verifique se o desconto concedido é aceitável.`;
                logAction(null, interaction.user.id, 'COUPON_OVER_LIMIT', `Pedido #${orderId} aprovado com cupom ${coupon.code} já no limite de usos.`);
            }
            incrementCouponUse(order.coupon_id);
        }

        // 3. Atualiza status do pedido
        updateOrderStatus(orderId, 'approved');

        // Processa Comissão de Afiliado
        const { processSaleCommission } = require('../../managers/affiliateManager');
        processSaleCommission(order);

        // Registro de Log de Venda

        logAction(null, interaction.user.id, 'APPROVE_ORDER', `Aprovou pedido #${orderId} do usuário ${order.user_id}${couponWarning ? ' (cupom acima do limite)' : ''}`);

        // 4. Notifica o usuário
        const user = await interaction.client.users.fetch(order.user_id);
        await user.send(`✅ **Seu pagamento foi aprovado!**\nO plano foi ativado com sucesso em sua conta. Aproveite!`).catch(() => {});

        // 5. Fecha o canal do carrinho
        const channel = interaction.guild.channels.cache.get(order.channel_id);
        if (channel) {
            await channel.send('✅ **Pagamento Aprovado!** Este canal será fechado em 10 segundos.');
            setTimeout(() => channel.delete().catch(() => {}), 10000);
        }

        // Limpa o arquivo de comprovante do disco — não precisamos mais dele
        // depois que o pedido foi processado (evita acúmulo indefinido).
        if (order.receipt_url && fs.existsSync(order.receipt_url)) {
            try { fs.unlinkSync(order.receipt_url); } catch { /* Ignora */ }
        }

        await interaction.editReply({ content: `✅ Pedido #${orderId} aprovado com sucesso!${couponWarning}` });
    } catch (err) {
        console.error('❌ Erro ao aprovar pedido:', err);
        // Reverte para 'in_analysis' já que o processamento não foi concluído,
        // permitindo que o admin tente aprovar novamente.
        updateOrderStatus(orderId, 'in_analysis');
        await interaction.editReply({ content: `❌ Erro ao aprovar pedido: ${err.message}` });
    }
}

else if (customId.startsWith('admin_reject_')) {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const orderId = customId.replace('admin_reject_', '');
    const modal = new ModalBuilder()
        .setCustomId(`modal_admin_reject_${orderId}`)
        .setTitle('❌ Recusar Pedido')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Motivo da Recusa')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Ex: Comprovante inválido ou valor incorreto.')
                    .setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_admin_reject_')) {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const orderId = customId.replace('modal_admin_reject_', '');
    const reason = interaction.fields.getTextInputValue('reason');
    const order = get("SELECT * FROM orders WHERE id = ?", [orderId]);

    // CORREÇÃO (crash): sem essa checagem, um orderId inválido/já removido
    // fazia order.user_id explodir com TypeError logo abaixo.
    if (!order) {
        return interaction.reply({ content: '❌ Pedido não encontrado.', ephemeral: true });
    }
    // CORREÇÃO (idempotência): mesmo problema do admin_approve_ — sem isso,
    // recusar o mesmo pedido duas vezes reenvia DM, tenta apagar o canal
    // de novo, e duplica o log.
    if (order.status !== 'in_analysis') {
        return interaction.reply({ content: `⚠️ Este pedido já foi processado (status atual: \`${order.status}\`).`, ephemeral: true });
    }

    updateOrderStatus(orderId, 'rejected', { rejection_reason: reason });
    

    logAction(null, interaction.user.id, 'REJECT_ORDER', `Recusou pedido #${orderId} (Motivo: ${reason})`);

    const user = await interaction.client.users.fetch(order.user_id);
    await user.send(`❌ **Seu pagamento foi recusado.**\n**Motivo:** ${reason}\nPor favor, entre em contato com o suporte se acreditar que isso é um erro.`).catch(() => {});

    const channel = interaction.guild.channels.cache.get(order.channel_id);
    if (channel) {
        await channel.send(`❌ **Pagamento Recusado!**\n**Motivo:** ${reason}\nEste canal será fechado em 10 segundos.`);
        setTimeout(() => channel.delete().catch(() => {}), 10000);
    }

    if (order.receipt_url && fs.existsSync(order.receipt_url)) {
        try { fs.unlinkSync(order.receipt_url); } catch { /* Ignora */ }
    }

    await interaction.reply({ content: `❌ Pedido #${orderId} recusado.`, ephemeral: true });
}

else if (customId === 'admin_config_pix') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const configPix = get("SELECT * FROM sales_config WHERE id = 1");
    
    const modal = new ModalBuilder()
        .setCustomId('modal_admin_config_pix')
        .setTitle('💰 Configurar Pix')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('pix_key')
                    .setLabel('Chave Pix')
                    .setStyle(TextInputStyle.Short)
                    .setValue(configPix.pix_key || '')
                    .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('pix_name')
                    .setLabel('Nome do Recebedor')
                    .setStyle(TextInputStyle.Short)
                    .setValue(configPix.pix_name || '')
                    .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('pix_city')
                    .setLabel('Cidade')
                    .setStyle(TextInputStyle.Short)
                    .setValue(configPix.pix_city || '')
                    .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('pix_qrcode')
                    .setLabel('URL do QR Code (Opcional)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(configPix.pix_qrcode || '')
                    .setRequired(false)
            )
        );
    await interaction.showModal(modal);
}

else if (customId === 'modal_admin_config_pix') {
    const pix_key = interaction.fields.getTextInputValue('pix_key');
    const pix_name = interaction.fields.getTextInputValue('pix_name');
    const pix_city = interaction.fields.getTextInputValue('pix_city');
    const pix_qrcode = interaction.fields.getTextInputValue('pix_qrcode');

    run(
        'UPDATE sales_config SET pix_key = ?, pix_name = ?, pix_city = ?, pix_qrcode = ? WHERE id = 1',
        [pix_key, pix_name, pix_city, pix_qrcode]
    );

    await interaction.reply({ content: '✅ Configurações Pix atualizadas com sucesso!', ephemeral: true });
}

else if (customId === 'admin_stats') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const today = new Date().toISOString().split('T')[0];
    const month = new Date().toISOString().substring(0, 7);

    const totalToday = get("SELECT SUM(total_price) as total FROM orders WHERE status = 'approved' AND date(created_at) = ?", [today]).total || 0;
    const totalMonth = get("SELECT SUM(total_price) as total FROM orders WHERE status = 'approved' AND strftime('%Y-%m', created_at) = ?", [month]).total || 0;
    
    const bestSeller = get(`
        SELECT p.name, COUNT(o.id) as sales 
        FROM orders o JOIN plans p ON o.plan_id = p.id 
        WHERE o.status = 'approved' 
        GROUP BY p.id ORDER BY sales DESC LIMIT 1
    `);

    const topCoupon = get(`
        SELECT c.code, COUNT(o.id) as uses 
        FROM orders o JOIN coupons c ON o.coupon_id = c.id 
        WHERE o.status = 'approved' 
        GROUP BY c.id ORDER BY uses DESC LIMIT 1
    `);

    const pendingCount = get("SELECT COUNT(*) as count FROM orders WHERE status = 'in_analysis'").count;

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('📈 Estatísticas de Vendas')
        .addFields(
            { name: '💰 Vendido Hoje', value: `\`R$ ${totalToday.toFixed(2)}\``, inline: true },
            { name: '📅 Vendido no Mês', value: `\`R$ ${totalMonth.toFixed(2)}\``, inline: true },
            { name: '📋 Pedidos Pendentes', value: `\`${pendingCount}\``, inline: true },
            { name: '🏆 Plano Mais Vendido', value: `\`${bestSeller?.name || 'Nenhum'}\` (${bestSeller?.sales || 0} vendas)`, inline: false },
            { name: '🎟 Cupom Mais Usado', value: `\`${topCoupon?.code || 'Nenhum'}\` (${topCoupon?.uses || 0} usos)`, inline: false }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

// CORREÇÃO (feature quebrada): o botão "Configurações" existia no painel
// admin mas não tinha handler nenhum — clicar não fazia nada.
else if (customId === 'admin_settings') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const totalBots = get('SELECT COUNT(*) as count FROM bots').count;
    const onlineBots = get("SELECT COUNT(*) as count FROM bots WHERE status = 'online'").count;
    const suspendedBots = get('SELECT COUNT(*) as count FROM bots WHERE suspended = 1').count;
    const crashLoopBots = get("SELECT COUNT(*) as count FROM bots WHERE health_status = 'crash_loop'").count;
    const totalUsers = get('SELECT COUNT(*) as count FROM users').count;

    const embed = new EmbedBuilder()
        .setColor(config.bot.color)
        .setTitle('⚙️ Configurações e Status do Sistema')
        .addFields(
            { name: '🤖 Bots', value: `Total: \`${totalBots}\`\nOnline: \`${onlineBots}\`\nSuspensos: \`${suspendedBots}\`\nEm Crash Loop: \`${crashLoopBots}\``, inline: true },
            { name: '👥 Usuários', value: `\`${totalUsers}\` cadastrados`, inline: true },
            { name: '🔒 Segurança', value: `RAM máx/bot: \`${config.security.maxRamPerBot}MB\`\nCPU máx/bot: \`${config.security.maxCpuPerBot}%\`\nTamanho máx de upload: \`${config.security.maxFileSizeMB}MB\``, inline: false },
            { name: '🔄 Auto-Restart', value: `Máx. tentativas: \`${config.system.autoRestartMaxAttempts}\`\nDelay entre tentativas: \`${config.system.autoRestartDelay}ms\``, inline: false },
            { name: '💾 Backup', value: `Auto-backup: \`${config.backup.autoBackup ? 'Ativado' : 'Desativado'}\`\nBackup diário: \`${config.backup.dailyBackup ? 'Ativado' : 'Desativado'}\``, inline: false }
        )
        .setFooter({ text: 'Configurações de segurança/sistema são definidas no .env — este painel é somente leitura.' })
        .setTimestamp();

    const settingsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('admin_security_logs').setLabel('Logs de Segurança').setEmoji('🔒').setStyle(ButtonStyle.Danger)
    );

    await interaction.reply({ embeds: [embed], components: [settingsRow], ephemeral: true });
}

// NOVA FEATURE: visualização de logs categorizados como 'security' —
// tentativas de acesso negadas (IDOR bloqueado, ação de admin sem
// permissão, etc.). Antes essas tentativas não ficavam registradas
// em lugar nenhum consultável; agora dá pra auditar quem tentou o quê.
else if (customId === 'admin_security_logs') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const { getLogsByType } = require('../../managers/logManager');
    const securityLogs = getLogsByType('security', 15);

    const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('🔒 Logs de Segurança (últimos 15)')
        .setDescription(
            securityLogs.length === 0
                ? 'Nenhum evento de segurança registrado ainda.'
                : securityLogs.map(l => `**${l.action}** — <@${l.user_id}> (\`${l.user_id}\`)\n> ${l.details}\n> <t:${Math.floor(new Date(l.created_at).getTime() / 1000)}:R>`).join('\n\n').substring(0, 4000)
        )
        .setFooter({ text: 'Eventos: tentativas de acesso negadas (IDOR, ações de admin sem permissão, etc.)' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

else if (customId === 'admin_manage_plans') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const modal = new ModalBuilder()
        .setCustomId('modal_admin_add_plan')
        .setTitle('📦 Adicionar/Editar Plano')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('id').setLabel('ID do Plano (Ex: premium)').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('name').setLabel('Nome do Plano').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('price').setLabel('Preço (Ex: 24.90)').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('bots').setLabel('Limite de Bots').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('ram').setLabel('Limite de RAM (MB)').setStyle(TextInputStyle.Short).setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId === 'modal_admin_add_plan') {
    const price = parseFloat(interaction.fields.getTextInputValue('price').replace(',', '.'));
    const maxBots = parseInt(interaction.fields.getTextInputValue('bots'));
    const maxRam = parseInt(interaction.fields.getTextInputValue('ram'));

    // CORREÇÃO: antes um admin digitando errado (ex: texto no lugar de
    // número) salvava NaN silenciosamente no banco, quebrando a exibição
    // do plano e o cálculo de limites em qualquer lugar que o usasse.
    if (!Number.isFinite(price) || price < 0) {
        return interaction.reply({ content: `${config.emojis.error} Preço inválido. Use um número, ex: 24.90.`, ephemeral: true });
    }
    if (!Number.isInteger(maxBots) || maxBots < 0) {
        return interaction.reply({ content: `${config.emojis.error} Limite de bots inválido. Use um número inteiro.`, ephemeral: true });
    }
    if (!Number.isInteger(maxRam) || maxRam <= 0) {
        return interaction.reply({ content: `${config.emojis.error} Limite de RAM inválido. Use um número inteiro maior que zero.`, ephemeral: true });
    }

    const planData = {
        id: interaction.fields.getTextInputValue('id').toLowerCase(),
        name: interaction.fields.getTextInputValue('name'),
        price,
        max_bots: maxBots,
        max_ram: maxRam,
        max_cpu: 100,
        status: 'active'
    };

    const { savePlan } = require('../../managers/planManager');
    savePlan(planData);

    await interaction.reply({ content: `✅ Plano **${planData.name}** salvo com sucesso!`, ephemeral: true });
}

// NOVA FEATURE: admin definir/trocar o plano de um usuário diretamente,
// sem precisar simular uma compra inteira (útil pra vendas manuais,
// cortesias, compensação por problemas, etc.)
else if (customId === 'admin_set_user_plan') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const modal = new ModalBuilder()
        .setCustomId('modal_admin_set_user_plan')
        .setTitle('👤 Definir Plano de Usuário')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('user_id').setLabel('ID do Usuário (Discord)').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('plan_id').setLabel('ID do Plano').setStyle(TextInputStyle.Short).setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId === 'modal_admin_set_user_plan') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const userId = interaction.fields.getTextInputValue('user_id').trim();
    const planId = interaction.fields.getTextInputValue('plan_id').trim().toLowerCase();

    if (!/^\d{17,20}$/.test(userId)) {
        return interaction.reply({ content: `${config.emojis.error} ID de usuário inválido. Use o ID numérico do Discord.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
        // CORREÇÃO (bug silencioso, não travava mas também não fazia nada):
        // activateUserPlan faz um UPDATE users SET ... WHERE id = ?. Se o
        // usuário-alvo nunca tivesse rodado /painel, essa linha não existia
        // na tabela — o UPDATE silenciosamente afetava 0 linhas, o admin via
        // "✅ sucesso" mas o plano nunca era aplicado de verdade. Registra
        // (buscando o perfil real no Discord) antes de tentar.
        const targetUser = await interaction.client.users.fetch(userId).catch(() => null);
        if (!targetUser) {
            return interaction.editReply({ content: `${config.emojis.error} Não encontrei nenhum usuário do Discord com esse ID.` });
        }
        registerUser(targetUser);

        const { activateUserPlan } = require('../../managers/planManager');
        await activateUserPlan(userId, planId, interaction.client, interaction.guild);
        logAction(null, interaction.user.id, 'ADMIN_SET_PLAN', `Definiu o plano ${planId} para o usuário ${userId}`);

        const { tryDM } = require('../../utils/clientRef');
        tryDM(userId, `✅ **Seu plano foi atualizado pela equipe!** Você agora está no plano \`${planId}\`.`);

        await interaction.editReply({ content: `${config.emojis.success} Plano \`${planId}\` definido para <@${userId}>!` });
    } catch (err) {
        await interaction.editReply({ content: `${config.emojis.error} Erro: ${err.message}` });
    }
}

// NOVA FEATURE: antes NÃO EXISTIA nenhuma forma de promover outra pessoa a
// admin/moderador dentro do bot — só o dono (OWNER_ID) tinha acesso de
// verdade (ver correção em userManager.js), e ele não tinha como delegar
// acesso de staff pra mais ninguém sem editar o banco de dados na mão. Este
// botão fecha essa lacuna.
else if (customId === 'admin_set_user_role') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const modal = new ModalBuilder()
        .setCustomId('modal_admin_set_user_role')
        .setTitle('🛡 Definir Cargo de Usuário')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('user_id').setLabel('ID do Usuário (Discord)').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('role').setLabel('Cargo: viewer, client, moderator ou admin').setStyle(TextInputStyle.Short).setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId === 'modal_admin_set_user_role') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const targetUserId = interaction.fields.getTextInputValue('user_id').trim();
    const role = interaction.fields.getTextInputValue('role').trim().toLowerCase();

    if (!/^\d{17,20}$/.test(targetUserId)) {
        return interaction.reply({ content: `${config.emojis.error} ID de usuário inválido. Use o ID numérico do Discord.`, ephemeral: true });
    }

    const { setUserRole, getUser, VALID_ROLES } = require('../../managers/userManager');
    if (!VALID_ROLES.includes(role)) {
        return interaction.reply({ content: `${config.emojis.error} Cargo inválido. Use um destes: ${VALID_ROLES.join(', ')}.`, ephemeral: true });
    }

    // Protege o dono (OWNER_ID): ele é promovido a admin automaticamente e
    // sempre precisa continuar admin — não faz sentido nem é seguro deixar
    // outro admin rebaixá-lo por engano (ou de propósito) por esta UI.
    if (targetUserId === config.bot.ownerId && role !== 'admin') {
        return interaction.reply({ content: `${config.emojis.error} Não é possível rebaixar o dono do bot (definido em OWNER_ID).`, ephemeral: true });
    }

    if (!getUser(targetUserId)) {
        return interaction.reply({ content: `${config.emojis.error} Este usuário ainda não interagiu com o bot nenhuma vez (sem registro). Peça pra ele rodar \`/painel\` primeiro.`, ephemeral: true });
    }

    setUserRole(targetUserId, role);
    logAction(null, interaction.user.id, 'ADMIN_SET_ROLE', `Definiu o cargo ${role} para o usuário ${targetUserId}`);
    logSecurityEvent(interaction.user.id, 'ROLE_CHANGE', `Promoveu/alterou <@${targetUserId}> para o cargo ${role}`);

    const { tryDM } = require('../../utils/clientRef');
    tryDM(targetUserId, `🛡 **Seu cargo no sistema foi atualizado pela equipe!** Você agora é \`${role}\`.`);

    await interaction.reply({ content: `${config.emojis.success} Cargo \`${role}\` definido para <@${targetUserId}>!`, ephemeral: true });
}

else if (customId === 'admin_manage_coupons') {
    if (!hasPermission(interaction.user.id, 'admin')) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou usar ação de admin (${customId}) sem permissão`); return interaction.reply({ content: '❌ Acesso negado.', ephemeral: true }); }

    const modal = new ModalBuilder()
        .setCustomId('modal_admin_add_coupon')
        .setTitle('🎟 Adicionar Cupom')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('code').setLabel('Código (Ex: WELCOME10)').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('type').setLabel('Tipo (percentage ou fixed)').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('value').setLabel('Valor (Ex: 10 ou 5.00)').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('uses').setLabel('Limite de Usos (0 para ilimitado)').setStyle(TextInputStyle.Short).setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId === 'modal_admin_add_coupon') {
    const typeRaw = interaction.fields.getTextInputValue('type').toLowerCase().trim();
    if (typeRaw !== 'percentage' && typeRaw !== 'fixed') {
        return interaction.reply({ content: `${config.emojis.error} Tipo inválido. Use \`percentage\` ou \`fixed\`.`, ephemeral: true });
    }

    const value = parseFloat(interaction.fields.getTextInputValue('value').replace(',', '.'));
    const maxUses = parseInt(interaction.fields.getTextInputValue('uses'));

    // CORREÇÃO: mesma proteção contra NaN silencioso do plano, aqui pro cupom.
    if (!Number.isFinite(value) || value <= 0) {
        return interaction.reply({ content: `${config.emojis.error} Valor inválido. Use um número maior que zero.`, ephemeral: true });
    }
    if (typeRaw === 'percentage' && value > 100) {
        return interaction.reply({ content: `${config.emojis.error} Cupom percentual não pode ser maior que 100.`, ephemeral: true });
    }
    if (!Number.isInteger(maxUses) || maxUses < 0) {
        return interaction.reply({ content: `${config.emojis.error} Limite de usos inválido. Use um número inteiro (0 para ilimitado).`, ephemeral: true });
    }

    const couponData = {
        code: interaction.fields.getTextInputValue('code').toUpperCase(),
        type: typeRaw,
        value,
        max_uses: maxUses,
        expires_at: null
    };

    const { createCoupon } = require('../../managers/couponManager');
    createCoupon(couponData);

    await interaction.reply({ content: `✅ Cupom **${couponData.code}** criado com sucesso!`, ephemeral: true });
}

    return true;
}

module.exports = { match, handle };
