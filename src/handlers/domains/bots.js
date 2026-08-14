/**
 * DOMÍNIO: BOTS
 * Extraído do interactionHandler (v8.3 modular).
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
const { hasPermission, getUser, canManageBot, registerUser } = require('../../managers/userManager');
const { logSecurityEvent, logAction, logUserAction } = require('../../managers/logManager');
const { checkRateLimit, formatRetryAfter } = require('../../utils/rateLimiter');
const { encrypt, decrypt, maskToken } = require('../../utils/crypto');
const { formatBytes, formatUptime, formatDate, formatProcessUptime } = require('../../utils/format');
const { startBot, stopBot, restartBot, getBotLogs, getSystemStats, getBotStats } = require('../../managers/processManager');
const { createBackup, restoreBackup, listBackups } = require('../../managers/backupManager');
const { listFiles, readFile, writeFile, createFolder, deleteItem, renameItem, copyFolderRecursive } = require('../../managers/fileManager');
const { getRecentLogs } = require('../../managers/consoleManager');
const { analyzeBotLogs } = require('../../managers/diagnosticManager');
const { getHealthDisplay } = require('../../managers/healthManager');
const { canAddBot, getUserPlanInfo } = require('../../managers/planManager');
const { installDependencies } = require('../../managers/dependencyManager');
const { generateBotCode, generateId } = require('../../utils/codeGenerator');
const { showBotPanel, showConfigPanel, showFileBrowser, showFileActions, encodeFilePath, decodeFilePath } = require('../panelHelpers');


const EXACT = ['my_bots', 'select_my_bot', 'config_bot_list', 'select_config_bot'];
const PREFIXES = ['bot_collabs_', 'bot_collab_add_', 'modal_bot_collab_add_', 'bot_collab_remove_', 'modal_bot_collab_remove_', 'bot_panel_', 'bot_start_', 'bot_stop_', 'bot_restart_', 'bot_logs_search_', 'modal_logs_search_', 'bot_logs_download_', 'bot_logs_clear_', 'bot_logs_', 'bot_ai_diag_', 'bot_stats_', 'bot_backup_', 'bot_clone_', 'bot_github_update_', 'bot_github_branch_', 'modal_github_branch_', 'bot_github_rollback_', 'select_github_rollback_', 'bot_suspend_', 'modal_bot_suspend_', 'bot_unsuspend_', 'config_edit_', 'modal_edit_', 'config_delete_', 'config_confirm_delete_', 'config_toggle_restart_', 'config_reinstall_deps_'];

// IDs do monólito (interactionHandler) que NÃO devem cair neste domínio
const BLOCKED = new Set([
    'bot_start_input',
    'modal_bot_start',
    'start_bots',
    'add_bot',
    'add_bot_modal',
    'settings',
    'back_to_panel',
]);

function match(customId) {
    if (!customId || BLOCKED.has(customId)) return false;
    if (EXACT.includes(customId)) return true;
    // Prefixo bot_start_ só conta se houver ID depois (bot_start_<uuid>)
    if (customId.startsWith('bot_start_') && customId === 'bot_start_input') return false;
    return PREFIXES.some(p => customId.startsWith(p));
}

async function handle(interaction, helpers = {}) {
    const customId = interaction.customId;

if (customId === 'my_bots') {
    // CORREÇÃO: só listava bots dos quais o usuário é DONO — bots onde ele
    // foi adicionado como colaborador nunca apareciam aqui, então não havia
    // como nem descobrir quais bots alheios ele tinha acesso pra gerenciar.
    const bots = query(
        `SELECT DISTINCT b.* FROM bots b
         LEFT JOIN bot_collaborators c ON c.bot_id = b.id AND c.user_id = ?
         WHERE b.creator_id = ? OR c.user_id IS NOT NULL
         ORDER BY b.created_at DESC`,
        [interaction.user.id, interaction.user.id]
    );

    if (bots.length === 0) {
        const embed = new EmbedBuilder()
            .setColor(config.bot.color)
            .setTitle(`${config.emojis.myBots} Meus Bots`)
            .setDescription('Você ainda não tem bots hospedados.\nClique em **Adicionar Bot** para começar.');
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('back_to_panel').setLabel('Voltar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('add_bot').setLabel('Adicionar Bot').setEmoji(config.emojis.add).setStyle(ButtonStyle.Primary)
        );
        return interaction.update({ embeds: [embed], components: [row] });
    }

    const embed = new EmbedBuilder()
        .setColor(config.bot.color)
        .setTitle(`${config.emojis.myBots} Meus Bots (${bots.length})`)
        .setDescription(
            bots.map((b, i) =>
                `**${i + 1}.** ${b.status === 'online' ? config.emojis.powerOn : config.emojis.powerOff} **${b.name}**${b.creator_id !== interaction.user.id ? ' *(colaborador)*' : ''}\n` +
                `> \`${b.code}\` · ${ (b.type||'bot') }${ b.port ? (' · :'+b.port) : '' } · RAM \`${b.ram_usage||0}MB\`\n` +
                `> Última atividade: \`${formatDate(b.last_activity)}\``
            ).join('\n\n')
        );

    const select = new StringSelectMenuBuilder()
        .setCustomId('select_my_bot')
        .setPlaceholder('Selecione um bot para gerenciar')
        .addOptions(bots.slice(0, 25).map(b => ({
            label: b.name.substring(0, 25),
            description: `${b.code} — ${b.status}${b.creator_id !== interaction.user.id ? ' (colaborador)' : ''}`,
            value: b.id,
            emoji: b.status === 'online' ? config.emojis.powerOn : config.emojis.powerOff,
        })));

    const row1 = new ActionRowBuilder().addComponents(select);
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('back_to_panel').setLabel('Voltar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({ embeds: [embed], components: [row1, row2] });
}

else if (customId === 'select_my_bot') {
    const botId = interaction.values[0];
    await showBotPanel(interaction, botId);
}

// ======================================================================
// PAINEL INDIVIDUAL DO BOT
// ======================================================================

else if (customId.startsWith('bot_collabs_')) {
    const botId = customId.replace('bot_collabs_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (bot.creator_id !== interaction.user.id) { logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou gerenciar equipe do bot ${botId} sem ser dono`); return interaction.reply({ content: '❌ Apenas o dono pode gerenciar a equipe.', ephemeral: true }); }

    const { getCollaborators } = require('../../managers/collaboratorManager');
    const collabs = getCollaborators(botId);

    const embed = new EmbedBuilder()
        .setColor('#00AAFF')
        .setTitle(`👥 Equipe do Bot — ${bot.name}`)
        .setDescription(
            collabs.map(c => `🔹 <@${c.user_id}> (\`${c.permissions}\`)`).join('\n') || 'Nenhum colaborador adicionado.'
        );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bot_collab_add_${botId}`).setLabel('Adicionar').setEmoji('➕').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`bot_collab_remove_${botId}`).setLabel('Remover').setEmoji('➖').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`bot_panel_${botId}`).setLabel('Voltar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

else if (customId.startsWith('bot_collab_add_')) {
    const botId = customId.replace('bot_collab_add_', '');
    const modal = new ModalBuilder()
        .setCustomId(`modal_bot_collab_add_${botId}`)
        .setTitle('➕ Adicionar Colaborador')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('user_id')
                    .setLabel('ID do Usuário')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('Ex: 123456789012345678')
                    .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('perms')
                    .setLabel('Permissões (separadas por vírgula)')
                    .setStyle(TextInputStyle.Short)
                    .setValue('view,start,stop,logs')
                    .setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_bot_collab_add_')) {
    const botId = customId.replace('modal_bot_collab_add_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    // CORREÇÃO (defesa em profundidade): esta ação alterava permissões de acesso
    // ao bot sem checar se quem enviou o modal é realmente o dono. Hoje o botão
    // que abre este modal só é mostrado ao dono (ver 'bot_collabs_'), mas a
    // checagem não deve depender só disso.
    if (bot.creator_id !== interaction.user.id) {
        logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou gerenciar equipe do bot ${botId} sem ser dono`);
        return interaction.reply({ content: '❌ Apenas o dono pode gerenciar a equipe.', ephemeral: true });
    }

    const userId = interaction.fields.getTextInputValue('user_id').trim();
    const perms = interaction.fields.getTextInputValue('perms').trim().toLowerCase();

    // Validação: precisa ser um snowflake válido do Discord (17-20 dígitos)
    if (!/^\d{17,20}$/.test(userId)) {
        return interaction.reply({ content: `${config.emojis.error} ID de usuário inválido. Use o ID numérico do Discord.`, ephemeral: true });
    }
    if (userId === bot.creator_id) {
        return interaction.reply({ content: `${config.emojis.error} O dono já tem acesso total, não é necessário adicioná-lo.`, ephemeral: true });
    }

    // Sanitiza a lista de permissões: só aceita palavras conhecidas, evita lixo/duplicatas
    const VALID_PERMS = ['view', 'start', 'stop', 'logs', 'backup', 'delete', 'config'];
    const cleanPerms = [...new Set(perms.split(',').map(p => p.trim()).filter(p => VALID_PERMS.includes(p)))];
    if (cleanPerms.length === 0) {
        return interaction.reply({ content: `${config.emojis.error} Nenhuma permissão válida informada. Use: ${VALID_PERMS.join(', ')}`, ephemeral: true });
    }

    // CORREÇÃO CRÍTICA (mesmo bug do FOREIGN KEY, variação diferente): aqui
    // quem precisa existir na tabela users não é quem está preenchendo o
    // modal (esse já foi registrado no topo do handleInteraction), e sim o
    // ID DIGITADO no campo — uma pessoa que pode nunca ter interagido com o
    // Atlantic Host. bot_collaborators.user_id também tem FOREIGN KEY pra
    // users(id), então adicionar alguém que nunca usou o bot quebrava com o
    // mesmo "FOREIGN KEY constraint failed". Busca o perfil real no Discord
    // (também serve pra validar que o ID existe de verdade) e registra antes.
    const targetUser = await interaction.client.users.fetch(userId).catch(() => null);
    if (!targetUser) {
        return interaction.reply({ content: `${config.emojis.error} Não encontrei nenhum usuário do Discord com esse ID.`, ephemeral: true });
    }
    registerUser(targetUser);

    const { addCollaborator } = require('../../managers/collaboratorManager');
    addCollaborator(botId, userId, cleanPerms.join(','));
    logAction(botId, interaction.user.id, 'CONFIG', `Colaborador <@${userId}> adicionado com permissões: ${cleanPerms.join(',')}`);

    await interaction.reply({ content: `✅ Colaborador <@${userId}> adicionado com permissões: \`${cleanPerms.join(', ')}\`!`, ephemeral: true });
}

// CORREÇÃO: o botão "Remover" colaborador existia na UI mas não tinha handler
// (clique não fazia nada). Implementado abaixo, com checagem de dono.
else if (customId.startsWith('bot_collab_remove_')) {
    const botId = customId.replace('bot_collab_remove_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (bot.creator_id !== interaction.user.id) {
        logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou gerenciar equipe do bot ${botId} sem ser dono`);
        return interaction.reply({ content: '❌ Apenas o dono pode gerenciar a equipe.', ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId(`modal_bot_collab_remove_${botId}`)
        .setTitle('➖ Remover Colaborador')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('user_id')
                    .setLabel('ID do Usuário')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('Ex: 123456789012345678')
                    .setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_bot_collab_remove_')) {
    const botId = customId.replace('modal_bot_collab_remove_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (bot.creator_id !== interaction.user.id) {
        logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou gerenciar equipe do bot ${botId} sem ser dono`);
        return interaction.reply({ content: '❌ Apenas o dono pode gerenciar a equipe.', ephemeral: true });
    }

    const userId = interaction.fields.getTextInputValue('user_id').trim();
    const { removeCollaborator } = require('../../managers/collaboratorManager');
    removeCollaborator(botId, userId);
    logAction(botId, interaction.user.id, 'CONFIG', `Colaborador <@${userId}> removido`);

    await interaction.reply({ content: `✅ Colaborador <@${userId}> removido!`, ephemeral: true });
}

else if (customId.startsWith('bot_panel_')) {
    const botId = customId.replace('bot_panel_', '');
    await showBotPanel(interaction, botId);
}

else if (customId.startsWith('bot_start_')) {
    const botId = customId.replace('bot_start_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'start')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para gerenciar este bot.`, ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    try {
        await startBot(botId);
        logAction(botId, interaction.user.id, 'START', 'Bot iniciado via painel individual');
        await interaction.editReply({ content: `${config.emojis.success} Bot iniciado!` });
    } catch (err) {
        await interaction.editReply({ content: `${config.emojis.error} ${err.message}` });
    }
}

else if (customId.startsWith('bot_stop_')) {
    const botId = customId.replace('bot_stop_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'stop')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para gerenciar este bot.`, ephemeral: true });
    }
    stopBot(botId);
    logAction(botId, interaction.user.id, 'STOP', 'Bot desligado via painel individual');
    await interaction.reply({ content: `${config.emojis.success} Bot desligado!`, ephemeral: true });
}

else if (customId.startsWith('bot_restart_')) {
    const botId = customId.replace('bot_restart_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'start')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para gerenciar este bot.`, ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    try {
        await restartBot(botId);
        logAction(botId, interaction.user.id, 'RESTART', 'Bot reiniciado via painel individual');
        await interaction.editReply({ content: `${config.emojis.success} Bot reiniciado!` });
    } catch (err) {
        await interaction.editReply({ content: `${config.emojis.error} ${err.message}` });
    }
}

// CORREÇÃO (bug de roteamento): este bloco genérico ficava ANTES dos
// handlers mais específicos 'bot_logs_search_', 'bot_logs_download_' e
// 'bot_logs_clear_' na cadeia if/else-if. Como esses customIds também
// começam com o prefixo 'bot_logs_', o startsWith('bot_logs_') abaixo
// capturava TODOS os cliques desses botões antes que eles chegassem
// aos handlers corretos — "Pesquisar", "Baixar" e "Limpar" nunca
// funcionavam, sempre caindo aqui e reabrindo a view genérica de logs.
// Movido para depois dos handlers específicos para que sejam
// verificados primeiro.
else if (customId.startsWith('bot_logs_search_')) {
    const botId = customId.replace('bot_logs_search_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'logs')) {
        logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou pesquisar logs do bot ${botId} sem permissão`);
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId(`modal_logs_search_${botId}`)
        .setTitle('🔍 Pesquisar nos Logs')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('term').setLabel('Termo de busca').setStyle(TextInputStyle.Short).setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_logs_search_')) {
    const botId = customId.replace('modal_logs_search_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'logs')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const term = interaction.fields.getTextInputValue('term').trim();
    const { searchLogs } = require('../../managers/consoleManager');
    const matches = searchLogs(botId, term, 30);

    const embed = new EmbedBuilder()
        .setColor(config.bot.color)
        .setTitle(`🔍 Resultados para "${term}" — ${bot.name}`)
        .setDescription(matches.length === 0 ? 'Nenhuma linha encontrada nos logs recentes.' : `\`\`\`md\n${matches.join('\n').substring(0, 3900)}\n\`\`\``)
        .setFooter({ text: 'Busca só cobre as últimas ~50 linhas em memória. Para histórico completo, baixe o log.' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

else if (customId.startsWith('bot_logs_download_')) {
    const botId = customId.replace('bot_logs_download_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'logs')) {
        logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou baixar logs do bot ${botId} sem permissão`);
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const { getLogFilePath } = require('../../managers/consoleManager');
    const logPath = getLogFilePath(botId);
    if (!logPath) return interaction.reply({ content: `${config.emojis.error} Nenhum log registrado em disco ainda.`, ephemeral: true });

    const stats = fs.statSync(logPath);
    if (stats.size > 8 * 1024 * 1024) {
        return interaction.reply({ content: `${config.emojis.error} Arquivo de log maior que 8MB, não é possível enviar por aqui.`, ephemeral: true });
    }

    const attachment = new AttachmentBuilder(logPath, { name: `${bot.code}.log` });
    await interaction.reply({ files: [attachment], ephemeral: true });
}

else if (customId.startsWith('bot_logs_clear_')) {
    const botId = customId.replace('bot_logs_clear_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou limpar logs do bot ${botId} sem permissão`);
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const { clearBuffer } = require('../../managers/consoleManager');
    clearBuffer(botId);
    logAction(botId, interaction.user.id, 'CONFIG', 'Console limpo (buffer em memória)');

    await interaction.reply({ content: `${config.emojis.success} Console limpo! *(o arquivo de log em disco não foi apagado, só a visualização em tempo real — use "Baixar" se precisar do histórico completo.)*`, ephemeral: true });
}

else if (customId.startsWith('bot_logs_')) {
    const botId = customId.replace('bot_logs_', '');
    const botForLogs = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!botForLogs) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, botForLogs, 'logs')) {
        logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou ver logs do bot ${botId} sem permissão`);
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para ver os logs deste bot.`, ephemeral: true });
    }
    
    const logText = getRecentLogs(botId);

    const embed = new EmbedBuilder()
        .setColor(config.bot.color)
        .setTitle(`${config.emojis.logs} Console (Live) — ${botForLogs.name}`)
        .setDescription(`\`\`\`md\n${logText.substring(0, 3900)}\n\`\`\``)
        .setFooter({ text: 'Mostrando as últimas 50 linhas do console.' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bot_panel_${botId}`).setLabel('Voltar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bot_logs_${botId}`).setLabel('Atualizar').setEmoji(config.emojis.restart).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bot_ai_diag_${botId}`).setLabel('IA Diagnóstico').setEmoji('🧠').setStyle(ButtonStyle.Primary)
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bot_logs_search_${botId}`).setLabel('Pesquisar').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bot_logs_download_${botId}`).setLabel('Baixar').setEmoji('⬇️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bot_logs_clear_${botId}`).setLabel('Limpar').setEmoji('🧹').setStyle(ButtonStyle.Danger)
    );

    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [embed], components: [row, row2] });
    } else {
        await interaction.reply({ embeds: [embed], components: [row, row2], ephemeral: true });
    }
}

else if (customId.startsWith('bot_ai_diag_')) {
    const botId = customId.replace('bot_ai_diag_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    // CORREÇÃO CRÍTICA (IDOR): este endpoint expunha o conteúdo dos logs
    // (via diagnóstico de IA) de QUALQUER bot para QUALQUER usuário.
    if (!canManageBot(interaction.user.id, bot, 'logs')) {
        logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou diagnosticar o bot ${botId} sem permissão`);
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para diagnosticar este bot.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    
    const logText = getRecentLogs(botId);
    const { analyzeBotLogs } = require('../../managers/diagnosticManager');
    const diagnosis = await analyzeBotLogs(botId, logText);

    const embed = new EmbedBuilder()
        .setColor('#7289DA')
        .setTitle(`🧠 Diagnóstico IA (Groq) — ${bot.name}`)
        .setDescription(diagnosis)
        .setFooter({ text: 'IA baseada em Llama-3.1 via Groq API' });

    await interaction.editReply({ embeds: [embed] });
}

else if (customId.startsWith('bot_stats_')) {
    const botId = customId.replace('bot_stats_', '');
    const stats = await getBotStats(botId);
    if (!stats) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    // CORREÇÃO CRÍTICA (IDOR): vazava criador, domínio, porta interna etc.
    // de qualquer bot para qualquer usuário.
    if (!canManageBot(interaction.user.id, stats)) {
        logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou ver estatísticas do bot ${botId} sem permissão`);
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para ver estatísticas deste bot.`, ephemeral: true });
    }

    let typeSpecific = '';
    if (stats.type === 'bot') {
        typeSpecific = `**Ping:** \`${stats.ping || 0}ms\`\n` +
                       `**Guilds:** \`${stats.guilds || 0}\`\n` +
                       `**Usuários:** \`${stats.users || 0}\`\n` +
                       `**Canais:** \`${stats.channels || 0}\`\n` +
                       `**Cargos:** \`${stats.roles || 0}\`\n` +
                       `**Comandos:** \`${stats.commands || 0}\`\n` +
                       `**Biblioteca:** \`${stats.library || 'N/A'}\`\n`;
    } else if (stats.type === 'web') {
        typeSpecific = `**Domínio:** \`${stats.domain || 'N/A'}\`\n` +
                       `**Porta Externa:** \`${stats.port || 'N/A'}\`\n` +
                       `**Porta Interna:** \`${stats.internal_port || 'N/A'}\`\n`;
    } else if (stats.type === 'minecraft') {
        typeSpecific = `**Versão:** \`${stats.minecraft_version || 'N/A'}\`\n` +
                       `**Tipo:** \`${stats.server_type || 'N/A'}\`\n` +
                       `**Porta:** \`${stats.port || 'N/A'}\`\n`;
    }

    const embed = new EmbedBuilder()
        .setColor(config.bot.color)
        .setTitle(`${config.emojis.stats} Estatísticas — [${stats.type.toUpperCase()}] ${stats.name}`)
        .setDescription(
            `**Status:** \`${stats.status}\`\n` +
            `**CPU:** \`${stats.cpu_usage || 0}%\`\n` +
            `**RAM:** \`${stats.ram_usage || 0}MB\`\n` +
            typeSpecific +
            `**Tempo Online:** \`${stats.uptimeFormatted}\`\n` +
            `**Última Reinicialização:** \`${formatDate(stats.last_start)}\`\n` +
            `**ID:** \`${stats.id}\`\n` +
            `**Criador:** <@${stats.creator_id}>`
        );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bot_panel_${botId}`).setLabel('Voltar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

else if (customId.startsWith('bot_backup_')) {
    const botId = customId.replace('bot_backup_', '');
    const botForBackup = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!botForBackup) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, botForBackup, 'backup')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para fazer backup deste bot.`, ephemeral: true });
    }

    // Backup manual zipa a pasta inteira do bot (I/O + CPU) — sem limite,
    // um usuário podia clicar em sequência e sobrecarregar o disco/CPU do
    // host repetidamente. Limite: 3 backups manuais por bot a cada 30min.
    const backupLimit = checkRateLimit(`backup:${botId}`, 3, 30 * 60 * 1000);
    if (!backupLimit.allowed) {
        return interaction.reply({ content: `${config.emojis.error} Limite de backups manuais atingido para este bot. Tente novamente em ${formatRetryAfter(backupLimit.retryAfterMs)}.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
        const { createBackup } = require('../../managers/backupManager');
        const backup = await createBackup(botId, 'manual');
        logAction(botId, interaction.user.id, 'BACKUP', `Backup criado: ${backup.path}`);

        // CORREÇÃO: o arquivo em disco agora é criptografado (AES-256-GCM)
        // para proteção em repouso — mas isso quebrava o envio por DM, que
        // mandava o arquivo criptografado direto (o cliente não conseguia
        // abrir). Descriptografamos em memória SÓ para gerar o anexo da DM;
        // o arquivo no disco continua sempre criptografado.
        const { decryptBuffer } = require('../../utils/fileCrypto');
        const encryptedOnDisk = fs.readFileSync(backup.path);
        const plainZipBuffer = decryptBuffer(encryptedOnDisk);

        const { AttachmentBuilder } = require('discord.js');
        const attachment = new AttachmentBuilder(plainZipBuffer, { name: `${botForBackup.code}_backup.zip` });

        await interaction.user.send({
            content: `${config.emojis.success} Aqui está o backup do seu bot **${botForBackup.name}**!\n🔒 Checksum SHA-256: \`${backup.checksum.substring(0, 16)}...\``,
            files: [attachment]
        }).catch(() => {
            return interaction.editReply({ content: `${config.emojis.success} Backup criado com sucesso!\nTamanho: ${formatBytes(backup.size)}\n⚠️ Não consegui enviar no seu DM, verifique se ele está aberto.` });
        });

        await interaction.editReply({ content: `${config.emojis.success} Backup criado com sucesso e enviado para o seu DM!\nTamanho: ${formatBytes(backup.size)}` });
    } catch (err) {
        await interaction.editReply({ content: `${config.emojis.error} ${err.message}` });
    }
}

// NOVA FEATURE: Clonar/Duplicar bot — copia arquivos e configuração para
// um novo bot. O TOKEN não é copiado de propósito: dois processos rodando
// ao mesmo tempo com o mesmo token do Discord causam conflito de sessão
// (o Discord derruba um dos dois). O dono precisa configurar um token novo
// antes de ligar o clone.
else if (customId.startsWith('bot_clone_')) {
    const botId = customId.replace('bot_clone_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para clonar este bot.`, ephemeral: true });
    }
    if (!canAddBot(interaction.user.id)) {
        const plan = getUserPlanInfo(interaction.user.id);
        return interaction.reply({ content: `${config.emojis.error} Você atingiu o limite do seu plano **${plan.name}** (${plan.maxBots} bot). Faça upgrade para clonar mais um!`, ephemeral: true });
    }
    // Mesma cota de criação de bot dos outros métodos (clone também gera
    // I/O de disco copiando a pasta inteira).
    const cloneLimit = checkRateLimit(`deploy:${interaction.user.id}`, 5, 60 * 60 * 1000);
    if (!cloneLimit.allowed) {
        return interaction.reply({ content: `${config.emojis.error} Limite de criação de bots atingido. Tente novamente em ${formatRetryAfter(cloneLimit.retryAfterMs)}.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const newBotId = generateId();
        const newCode = generateBotCode('BOT');
        const newFolderPath = path.resolve(config.system.botsFolder, newBotId);

        fs.mkdirSync(newFolderPath, { recursive: true });
        copyFolderRecursive(bot.folder_path, newFolderPath);
        // Remove qualquer .env copiado (pode conter credenciais do bot original
        // que não fazem sentido — inclusive o próprio token, se o código do bot
        // guarda uma cópia local dele em .env).
        const envPath = path.join(newFolderPath, '.env');
        if (fs.existsSync(envPath)) fs.unlinkSync(envPath);

        run(
            `INSERT INTO bots (id, code, name, description, type, token, language, main_file, java_version, minecraft_version, server_type, node_version, python_version, creator_id, folder_path, status, auto_restart)
             VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?)`,
            [newBotId, newCode, `${bot.name} (cópia)`, bot.description, bot.type, bot.language, bot.main_file,
             bot.java_version, bot.minecraft_version, bot.server_type, bot.node_version, bot.python_version,
             interaction.user.id, newFolderPath, bot.auto_restart]
        );

        logAction(newBotId, interaction.user.id, 'ADD', `Bot clonado a partir de ${bot.code} (${bot.name})`);
        logAction(botId, interaction.user.id, 'CLONE', `Bot clonado para ${newCode}`);

        await interaction.editReply({
            content: `${config.emojis.success} Bot clonado com sucesso!\n**Novo código:** \`${newCode}\`\n\n⚠️ **Importante:** o token NÃO foi copiado por segurança (dois bots não podem rodar com o mesmo token ao mesmo tempo). Configure um token novo no painel do clone antes de ligá-lo.`
        });
    } catch (err) {
        await interaction.editReply({ content: `${config.emojis.error} Erro ao clonar: ${err.message}` });
    }
}

// NOVA FEATURE: integração com GitHub — Atualizar (pull), Trocar Branch,
// Rollback. Só aparece para bots que têm github_repo configurado (via
// "Adicionar Bot via GitHub").
else if (customId.startsWith('bot_github_update_')) {
    const botId = customId.replace('bot_github_update_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }
    if (!bot.github_repo) return interaction.reply({ content: `${config.emojis.error} Este bot não está conectado a um repositório GitHub.`, ephemeral: true });

    await interaction.deferReply({ ephemeral: true });
    try {
        const { pullLatest, getCurrentCommit } = require('../../managers/githubManager');
        const before = await getCurrentCommit(bot.folder_path);
        await pullLatest(bot.folder_path);
        const after = await getCurrentCommit(bot.folder_path);

        if (before === after) {
            await interaction.editReply({ content: `${config.emojis.success} Já está tudo atualizado (nenhuma mudança nova em \`${bot.github_branch}\`).` });
        } else {
            await installDependencies(botId, bot.folder_path).catch(() => {});
            logAction(botId, interaction.user.id, 'GITHUB_UPDATE', `Atualizado de ${before?.substring(0, 7)} para ${after?.substring(0, 7)}`);
            const restartNote = bot.status === 'online' ? '\n⚠️ Reinicie o bot para aplicar a atualização.' : '';
            await interaction.editReply({ content: `${config.emojis.success} Atualizado com sucesso! \`${before?.substring(0, 7)}\` → \`${after?.substring(0, 7)}\`${restartNote}` });
        }
    } catch (err) {
        await interaction.editReply({ content: `${config.emojis.error} Falha ao atualizar: ${err.message}` });
    }
}

else if (customId.startsWith('bot_github_branch_')) {
    const botId = customId.replace('bot_github_branch_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }
    if (!bot.github_repo) return interaction.reply({ content: `${config.emojis.error} Este bot não está conectado a um repositório GitHub.`, ephemeral: true });

    const modal = new ModalBuilder()
        .setCustomId(`modal_github_branch_${botId}`)
        .setTitle('🌿 Trocar Branch')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('branch').setLabel('Nome da branch').setStyle(TextInputStyle.Short)
                    .setValue(bot.github_branch || 'main').setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_github_branch_')) {
    const botId = customId.replace('modal_github_branch_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const branch = interaction.fields.getTextInputValue('branch').trim();
    await interaction.deferReply({ ephemeral: true });
    try {
        const { switchBranch } = require('../../managers/githubManager');
        await switchBranch(bot.folder_path, branch);
        run('UPDATE bots SET github_branch = ? WHERE id = ?', [branch, botId]);
        await installDependencies(botId, bot.folder_path).catch(() => {});
        logAction(botId, interaction.user.id, 'GITHUB_BRANCH', `Trocou para a branch ${branch}`);

        const restartNote = bot.status === 'online' ? '\n⚠️ Reinicie o bot para aplicar a nova branch.' : '';
        await interaction.editReply({ content: `${config.emojis.success} Branch alterada para \`${branch}\`!${restartNote}` });
    } catch (err) {
        await interaction.editReply({ content: `${config.emojis.error} Falha ao trocar de branch: ${err.message}` });
    }
}

else if (customId.startsWith('bot_github_rollback_')) {
    const botId = customId.replace('bot_github_rollback_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }
    if (!bot.github_repo) return interaction.reply({ content: `${config.emojis.error} Este bot não está conectado a um repositório GitHub.`, ephemeral: true });

    await interaction.deferReply({ ephemeral: true });
    try {
        const { getCommitHistory } = require('../../managers/githubManager');
        const history = await getCommitHistory(bot.folder_path, 10);
        if (history.length === 0) {
            return interaction.editReply({ content: `${config.emojis.error} Nenhum histórico de commits encontrado.` });
        }

        const select = new StringSelectMenuBuilder()
            .setCustomId(`select_github_rollback_${botId}`)
            .setPlaceholder('Selecione um commit para reverter')
            .addOptions(history.map(h => ({
                label: `${h.hash.substring(0, 7)} — ${h.message}`.substring(0, 100),
                description: `${h.author} em ${h.date}`.substring(0, 100),
                value: h.hash,
            })));

        await interaction.editReply({
            content: `⚠️ **Atenção:** reverter apaga qualquer mudança feita depois do commit escolhido (incluindo edições manuais não commitadas). Escolha com cuidado:`,
            components: [new ActionRowBuilder().addComponents(select)]
        });
    } catch (err) {
        await interaction.editReply({ content: `${config.emojis.error} Erro ao buscar histórico: ${err.message}` });
    }
}

else if (customId.startsWith('select_github_rollback_')) {
    const botId = customId.replace('select_github_rollback_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const commitHash = interaction.values[0];
    await interaction.deferUpdate();
    try {
        const { rollbackToCommit } = require('../../managers/githubManager');
        await rollbackToCommit(bot.folder_path, commitHash);
        await installDependencies(botId, bot.folder_path).catch(() => {});
        logAction(botId, interaction.user.id, 'GITHUB_ROLLBACK', `Revertido para o commit ${commitHash.substring(0, 7)}`);

        const restartNote = bot.status === 'online' ? '\n⚠️ Reinicie o bot para aplicar a reversão.' : '';
        await interaction.editReply({ content: `${config.emojis.success} Revertido para \`${commitHash.substring(0, 7)}\` com sucesso!${restartNote}`, components: [] });
    } catch (err) {
        await interaction.editReply({ content: `${config.emojis.error} Falha no rollback: ${err.message}`, components: [] });
    }
}

// NOVA FEATURE: Suspender bot — ação de moderação/staff, diferente de
// "Desligar" (que o próprio dono pode fazer e desfazer livremente).
// Um bot suspenso não pode ser ligado nem pelo dono até um staff reativar.
else if (customId.startsWith('bot_suspend_')) {
    const botId = customId.replace('bot_suspend_', '');
    if (!hasPermission(interaction.user.id, 'moderator')) {
        return interaction.reply({ content: '❌ Apenas a equipe pode suspender bots.', ephemeral: true });
    }
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });

    const modal = new ModalBuilder()
        .setCustomId(`modal_bot_suspend_${botId}`)
        .setTitle('🚫 Suspender Bot')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('reason').setLabel('Motivo da suspensão').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(300)
            )
        );
    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_bot_suspend_')) {
    const botId = customId.replace('modal_bot_suspend_', '');
    if (!hasPermission(interaction.user.id, 'moderator')) {
        return interaction.reply({ content: '❌ Apenas a equipe pode suspender bots.', ephemeral: true });
    }
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });

    const reason = interaction.fields.getTextInputValue('reason');
    run('UPDATE bots SET suspended = 1, suspended_reason = ? WHERE id = ?', [reason, botId]);

    // Se estiver rodando, para imediatamente (suspensão vale já, não só no próximo start)
    if (bot.status === 'online') {
        stopBot(botId);
    }

    logAction(botId, interaction.user.id, 'SUSPEND', `Bot suspenso: ${reason}`);
    const { tryDM } = require('../../utils/clientRef');
    tryDM(bot.creator_id, `🚫 **Seu bot "${bot.name}" foi suspenso pela equipe.**\n**Motivo:** ${reason}\nEntre em contato com o suporte para mais informações.`);

    await interaction.reply({ content: `${config.emojis.success} Bot **${bot.name}** suspenso.`, ephemeral: true });
}

else if (customId.startsWith('bot_unsuspend_')) {
    const botId = customId.replace('bot_unsuspend_', '');
    if (!hasPermission(interaction.user.id, 'moderator')) {
        return interaction.reply({ content: '❌ Apenas a equipe pode reativar bots.', ephemeral: true });
    }
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });

    run('UPDATE bots SET suspended = 0, suspended_reason = NULL WHERE id = ?', [botId]);
    logAction(botId, interaction.user.id, 'UNSUSPEND', 'Bot reativado pela equipe');

    const { tryDM } = require('../../utils/clientRef');
    tryDM(bot.creator_id, `✅ **Seu bot "${bot.name}" foi reativado pela equipe.** Você já pode ligá-lo normalmente.`);

    await interaction.reply({ content: `${config.emojis.success} Bot **${bot.name}** reativado.`, ephemeral: true });
}

// NOVA FEATURE: Editar versão do runtime (Node.js/Python). Antes estes
// campos existiam no banco mas eram 100% decorativos — agora processManager
// realmente tenta usar a versão pedida (via nvm/binários versionados).
else if (customId.startsWith('config_edit_runtime_')) {
    const botId = customId.replace('config_edit_runtime_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId(`modal_edit_runtime_${botId}`)
        .setTitle('🧩 Versão do Runtime')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('version')
                    .setLabel(bot.language === 'python' ? 'Versão do Python (ex: 3.11)' : 'Versão major do Node.js (ex: 20)')
                    .setStyle(TextInputStyle.Short)
                    .setValue(String((bot.language === 'python' ? bot.python_version : bot.node_version) || ''))
                    .setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_edit_runtime_')) {
    const botId = customId.replace('modal_edit_runtime_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const version = interaction.fields.getTextInputValue('version').trim();
    if (!/^\d+(\.\d+)?$/.test(version)) {
        return interaction.reply({ content: `${config.emojis.error} Formato inválido. Use algo como \`20\` (Node) ou \`3.11\` (Python).`, ephemeral: true });
    }

    if (bot.language === 'python') {
        run('UPDATE bots SET python_version = ? WHERE id = ?', [version, botId]);
    } else {
        run('UPDATE bots SET node_version = ? WHERE id = ?', [version, botId]);
    }
    logAction(botId, interaction.user.id, 'CONFIG', `Versão do runtime alterada para ${version}`);

    const restartNote = bot.status === 'online'
        ? '\n⚠️ O bot está online e continua rodando na versão antiga até ser reiniciado.'
        : '';
    await interaction.reply({ content: `${config.emojis.success} Versão do runtime definida como \`${version}\`. Se a versão não estiver disponível no servidor, o sistema usa a padrão automaticamente e avisa no console do bot.${restartNote}`, ephemeral: true });
}

    
// --- config bot (extraído do handler principal) ---
if (customId === 'config_bot_list') {
    const bots = query('SELECT * FROM bots WHERE creator_id = ? ORDER BY created_at DESC', [interaction.user.id]);
    if (bots.length === 0) {
        // CORREÇÃO: usa reply em vez de update para não precisar de embed anterior
        return interaction.reply({ content: `${config.emojis.error} Você não tem bots para configurar.`, ephemeral: true });
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId('select_config_bot')
        .setPlaceholder('Selecione um bot para configurar')
        .addOptions(bots.slice(0, 25).map(b => ({
            label: b.name.substring(0, 25),
            description: b.code,
            value: b.id,
            emoji: b.status === 'online' ? config.emojis.powerOn : config.emojis.powerOff,
        })));

    const embed = new EmbedBuilder()
        .setColor(config.bot.color)
        .setTitle(`${config.emojis.configBot} Configurar Bot`)
        .setDescription('Selecione o bot que deseja configurar:');

    const row = new ActionRowBuilder().addComponents(select);
    await interaction.update({ embeds: [embed], components: [row] });
}

else if (customId === 'select_config_bot') {
    const botId = interaction.values[0];
    await showConfigPanel(interaction, botId);
}

// ======================================================================
// CONFIG BOT — EDIÇÕES IMPLEMENTADAS
// ======================================================================

else if (customId.startsWith('config_edit_name_')) {
    const botId = customId.replace('config_edit_name_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId(`modal_edit_name_${botId}`)
        .setTitle('Editar Nome do Bot');

    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('new_name')
                .setLabel('Novo Nome')
                .setStyle(TextInputStyle.Short)
                .setValue(bot.name)
                .setMinLength(1)
                .setMaxLength(32)
                .setRequired(true)
        )
    );

    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_edit_name_')) {
    const botId = customId.replace('modal_edit_name_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const newName = interaction.fields.getTextInputValue('new_name').trim();
    run("UPDATE bots SET name = ?, updated_at = datetime('now') WHERE id = ?", [newName, botId]);
    logAction(botId, interaction.user.id, 'CONFIG', `Nome alterado para: ${newName}`);

    await interaction.reply({ content: `${config.emojis.success} Nome atualizado para **${newName}**!`, ephemeral: true });
}

else if (customId.startsWith('config_edit_desc_')) {
    const botId = customId.replace('config_edit_desc_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId(`modal_edit_desc_${botId}`)
        .setTitle('Editar Descrição do Bot');

    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('new_desc')
                .setLabel('Nova Descrição')
                .setStyle(TextInputStyle.Paragraph)
                .setValue(bot.description || '')
                .setMaxLength(200)
                .setRequired(false)
        )
    );

    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_edit_desc_')) {
    const botId = customId.replace('modal_edit_desc_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const newDesc = interaction.fields.getTextInputValue('new_desc')?.trim() || '';
    run("UPDATE bots SET description = ?, updated_at = datetime('now') WHERE id = ?", [newDesc, botId]);
    logAction(botId, interaction.user.id, 'CONFIG', 'Descrição atualizada');

    await interaction.reply({ content: `${config.emojis.success} Descrição atualizada!`, ephemeral: true });
}

else if (customId.startsWith('config_edit_token_')) {
    const botId = customId.replace('config_edit_token_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId(`modal_edit_token_${botId}`)
        .setTitle('Editar Token do Bot');

    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('new_token')
                .setLabel('Novo Token')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('MTA0...')
                .setMinLength(50)
                .setMaxLength(100)
                .setRequired(true)
        )
    );

    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_edit_token_')) {
    const botId = customId.replace('modal_edit_token_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const newToken = interaction.fields.getTextInputValue('new_token').trim();
    if (!TOKEN_REGEX.test(newToken)) {
        return interaction.reply({ content: `${config.emojis.error} Token inválido! Verifique o formato.`, ephemeral: true });
    }

    run("UPDATE bots SET token = ?, updated_at = datetime('now') WHERE id = ?", [encrypt(newToken), botId]);
    logAction(botId, interaction.user.id, 'CONFIG', 'Token atualizado');

    // CORREÇÃO (UX/correção enganosa): o processo em execução mantém o
    // token ANTIGO nas variáveis de ambiente carregadas no start — trocar
    // o token no banco não afeta o processo já rodando. Sem avisar isso,
    // o usuário acha que já trocou e o bot continua logado com o token
    // antigo até um restart manual.
    const restartNote = bot.status === 'online'
        ? '\n⚠️ O bot está online e continua usando o token antigo até ser reiniciado. Reinicie-o para aplicar o novo token.'
        : '';

    await interaction.reply({ content: `${config.emojis.success} Token atualizado com sucesso!${restartNote}`, ephemeral: true });
}

else if (customId.startsWith('config_toggle_restart_')) {
    const botId = customId.replace('config_toggle_restart_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const newValue = bot.auto_restart ? 0 : 1;
    run("UPDATE bots SET auto_restart = ?, updated_at = datetime('now') WHERE id = ?", [newValue, botId]);
    logAction(botId, interaction.user.id, 'CONFIG', `Auto Restart ${newValue ? 'ativado' : 'desativado'}`);

    await interaction.reply({
        content: `${config.emojis.success} Auto Restart **${newValue ? 'ativado' : 'desativado'}** para o bot **${bot.name}**!`,
        ephemeral: true,
    });
}

else if (customId.startsWith('config_reinstall_deps_')) {
    const botId = customId.replace('config_reinstall_deps_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });
    try {
        const success = await installDependencies(botId, bot.folder_path);
        logAction(botId, interaction.user.id, 'CONFIG', 'Reinstalação de dependências solicitada manualmente');
        const restartNote = bot.status === 'online' ? '\n⚠️ Reinicie o bot para os arquivos recompilados entrarem em uso.' : '';
        await interaction.editReply({
            content: success
                ? `${config.emojis.success} Dependências reinstaladas (npm/pip install, \`prisma generate\` e \`build\` quando detectados).${restartNote}`
                : `${config.emojis.error} A reinstalação terminou com falha — confira os logs do bot (📜 Logs) para o erro exato.`,
        });
    } catch (err) {
        await interaction.editReply({ content: `${config.emojis.error} Erro ao reinstalar: ${err.message}` });
    }
}

else if (customId.startsWith('config_delete_')) {
    const botId = customId.replace('config_delete_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'delete')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para excluir este bot.`, ephemeral: true });
    }

    // CORREÇÃO CRÍTICA: mesmo problema do bot_delete_ — exclusão de 1 clique
    // só, sem confirmação, pra uma ação irreversível. Agora exige confirmação.
    const confirmEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle(`⚠️ Confirmar Exclusão`)
        .setDescription(
            `Tem certeza que deseja excluir **${bot.name}** permanentemente?\n\n` +
            `Isso vai parar o processo, apagar todos os arquivos, variáveis de ambiente e backups do bot, ` +
            `e remover seu registro. Um backup de segurança será feito automaticamente antes, mas essa ação não pode ser desfeita pelo painel.`
        );
    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`config_confirm_delete_${botId}`).setLabel('Sim, excluir permanentemente').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`select_config_bot`).setLabel('Cancelar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
}

else if (customId.startsWith('config_confirm_delete_')) {
    const botId = customId.replace('config_confirm_delete_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado (talvez já tenha sido excluído).', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'delete')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para excluir este bot.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    let backupWarning = '';
    try {
        const { createBackup } = require('../../managers/backupManager');
        await createBackup(botId, 'pre-delete');
    } catch (err) {
        backupWarning = `\n⚠️ Não foi possível criar o backup de segurança antes de excluir: ${err.message}`;
    }

    // Espera o processo parar de verdade antes de apagar os arquivos
    if (bot.status === 'online') {
        stopBot(botId);
        const deadline = Date.now() + 6000;
        const { activeProcesses } = require('../../managers/processManager');
        while (Date.now() < deadline && activeProcesses.has(botId)) {
            await new Promise(r => setTimeout(r, 250));
        }
    }

    // Remove pasta do disco (incluindo .env)
    if (fs.existsSync(bot.folder_path)) {
        fs.rmSync(bot.folder_path, { recursive: true, force: true });
    }

    // Limpa variáveis de ambiente do bot
    run('DELETE FROM env_variables WHERE bot_id = ?', [botId]);

    // Remove backups do bot do disco
    const backups = query('SELECT file_path FROM backups WHERE bot_id = ?', [botId]);
    for (const bk of backups) {
        try { if (fs.existsSync(bk.file_path)) fs.unlinkSync(bk.file_path); } catch { /* Ignora */ }
    }
    run('DELETE FROM backups WHERE bot_id = ?', [botId]);

    // Remove do banco
    run('DELETE FROM bots WHERE id = ?', [botId]);
    logAction(botId, interaction.user.id, 'DELETE', `Bot excluído via config: ${bot.name}`);
    logUserAction(interaction.user.id, botId, 'DELETE_BOT', `Excluiu bot ${bot.name}`);

    await interaction.editReply({ content: `${config.emojis.success} Bot **${bot.name}** excluído permanentemente.${backupWarning}` });
}


return true;
}

module.exports = { match, handle };
