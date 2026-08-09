/**
 * DOMÍNIO: FILES
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
const { hasPermission, getUser, canManageBot } = require('../../managers/userManager');
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
const { installDependencies } = require('../../managers/dependencyManager');
const { generateBotCode, generateId } = require('../../utils/codeGenerator');
const { showBotPanel, showConfigPanel, showFileBrowser, showFileActions, encodeFilePath, decodeFilePath } = require('../panelHelpers');


const EXACT = [];
const PREFIXES = ['bot_files_', 'files_nav_', 'files_select_', 'files_create_file_', 'modal_files_create_file_', 'files_create_folder_', 'modal_files_create_folder_', 'file_view_', 'file_download_', 'file_rename_', 'modal_file_rename_', 'file_delete_', 'confirm_file_delete_', 'bot_delete_', 'confirm_delete_'];

function match(customId) {
    if (EXACT.includes(customId)) return true;
    return PREFIXES.some(p => customId.startsWith(p));
}

async function handle(interaction, helpers = {}) {
    const customId = interaction.customId;

if (customId.startsWith('bot_files_')) {
    const botId = customId.replace('bot_files_', '');
    await showFileBrowser(interaction, botId, '');
}

else if (customId.startsWith('files_nav_')) {
    const rest = customId.replace('files_nav_', '');
    const [botId, encodedPath] = rest.split('::');
    await showFileBrowser(interaction, botId, decodeFilePath(encodedPath));
}

else if (customId.startsWith('files_select_')) {
    const rest = customId.replace('files_select_', '');
    const [botId, encodedSubpath] = rest.split('::');
    const subpath = decodeFilePath(encodedSubpath);
    const [kind, encodedItemPath] = interaction.values[0].split(':');
    const itemPath = decodeFilePath(encodedItemPath);

    if (kind === 'd') {
        await showFileBrowser(interaction, botId, itemPath);
    } else {
        await showFileActions(interaction, botId, itemPath, subpath);
    }
}

else if (customId.startsWith('files_create_file_')) {
    const rest = customId.replace('files_create_file_', '');
    const [botId, encodedSubpath] = rest.split('::');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId(`modal_files_create_file_${botId}::${encodedSubpath}`)
        .setTitle('📄 Criar Arquivo')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('name').setLabel('Nome do arquivo (ex: config.json)').setStyle(TextInputStyle.Short).setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('content').setLabel('Conteúdo inicial (opcional)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(3900)
            )
        );
    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_files_create_file_')) {
    const rest = customId.replace('modal_files_create_file_', '');
    const [botId, encodedSubpath] = rest.split('::');
    const subpath = decodeFilePath(encodedSubpath);
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const name = interaction.fields.getTextInputValue('name').trim();
    const content = interaction.fields.getTextInputValue('content') || '';
    if (/[\\/]/.test(name) || name === '..' || name === '.') {
        return interaction.reply({ content: `${config.emojis.error} Nome de arquivo inválido.`, ephemeral: true });
    }

    try {
        writeFile(bot.folder_path, path.join(subpath, name), content);
        logAction(botId, interaction.user.id, 'CONFIG', `Arquivo criado: ${path.join(subpath, name)}`);
        await interaction.reply({ content: `${config.emojis.success} Arquivo \`${name}\` criado!`, ephemeral: true });
    } catch (err) {
        await interaction.reply({ content: `${config.emojis.error} Erro: ${err.message}`, ephemeral: true });
    }
}

else if (customId.startsWith('files_create_folder_')) {
    const rest = customId.replace('files_create_folder_', '');
    const [botId, encodedSubpath] = rest.split('::');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId(`modal_files_create_folder_${botId}::${encodedSubpath}`)
        .setTitle('📁 Criar Pasta')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('name').setLabel('Nome da pasta').setStyle(TextInputStyle.Short).setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_files_create_folder_')) {
    const rest = customId.replace('modal_files_create_folder_', '');
    const [botId, encodedSubpath] = rest.split('::');
    const subpath = decodeFilePath(encodedSubpath);
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const name = interaction.fields.getTextInputValue('name').trim();
    if (/[\\/]/.test(name) || name === '..' || name === '.') {
        return interaction.reply({ content: `${config.emojis.error} Nome de pasta inválido.`, ephemeral: true });
    }

    try {
        createFolder(bot.folder_path, path.join(subpath, name));
        logAction(botId, interaction.user.id, 'CONFIG', `Pasta criada: ${path.join(subpath, name)}`);
        await interaction.reply({ content: `${config.emojis.success} Pasta \`${name}\` criada!`, ephemeral: true });
    } catch (err) {
        await interaction.reply({ content: `${config.emojis.error} Erro: ${err.message}`, ephemeral: true });
    }
}

else if (customId.startsWith('file_view_')) {
    const rest = customId.replace('file_view_', '');
    const [botId, encodedPath] = rest.split('::');
    const filePath = decodeFilePath(encodedPath);
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'view')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    try {
        const content = readFile(bot.folder_path, filePath);
        if (content === null) return interaction.reply({ content: `${config.emojis.error} Arquivo não encontrado.`, ephemeral: true });

        // Arquivo binário ou grande demais pra mostrar em texto — melhor baixar
        const isProbablyBinary = /\0/.test(content.substring(0, 1000));
        if (isProbablyBinary || content.length > 3900) {
            return interaction.reply({ content: `${config.emojis.warning} Arquivo muito grande ou binário para visualizar aqui. Use "Baixar" para ver o conteúdo completo.`, ephemeral: true });
        }

        await interaction.reply({ content: `\`\`\`\n${content.substring(0, 1900)}\n\`\`\`${content.length > 1900 ? '\n*(truncado — use "Baixar" para ver tudo)*' : ''}`, ephemeral: true });
    } catch (err) {
        await interaction.reply({ content: `${config.emojis.error} Erro: ${err.message}`, ephemeral: true });
    }
}

else if (customId.startsWith('file_download_')) {
    const rest = customId.replace('file_download_', '');
    const [botId, encodedPath] = rest.split('::');
    const filePath = decodeFilePath(encodedPath);
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'view')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    try {
        const fullPath = path.join(bot.folder_path, filePath);
        if (!fs.existsSync(fullPath)) return interaction.reply({ content: `${config.emojis.error} Arquivo não encontrado.`, ephemeral: true });
        const stats = fs.statSync(fullPath);
        if (stats.size > 8 * 1024 * 1024) {
            return interaction.reply({ content: `${config.emojis.error} Arquivo maior que 8MB, não é possível enviar por aqui.`, ephemeral: true });
        }
        const attachment = new AttachmentBuilder(fullPath, { name: path.basename(filePath) });
        await interaction.reply({ files: [attachment], ephemeral: true });
    } catch (err) {
        await interaction.reply({ content: `${config.emojis.error} Erro: ${err.message}`, ephemeral: true });
    }
}

else if (customId.startsWith('file_rename_')) {
    const rest = customId.replace('file_rename_', '');
    const [botId, encodedPath] = rest.split('::');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId(`modal_file_rename_${botId}::${encodedPath}`)
        .setTitle('✏️ Renomear')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('name').setLabel('Novo nome').setStyle(TextInputStyle.Short).setRequired(true)
            )
        );
    await interaction.showModal(modal);
}

else if (customId.startsWith('modal_file_rename_')) {
    const rest = customId.replace('modal_file_rename_', '');
    const [botId, encodedPath] = rest.split('::');
    const filePath = decodeFilePath(encodedPath);
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const newName = interaction.fields.getTextInputValue('name').trim();
    try {
        renameItem(bot.folder_path, filePath, newName);
        logAction(botId, interaction.user.id, 'CONFIG', `Renomeado: ${filePath} -> ${newName}`);
        await interaction.reply({ content: `${config.emojis.success} Renomeado para \`${newName}\`!`, ephemeral: true });
    } catch (err) {
        await interaction.reply({ content: `${config.emojis.error} Erro: ${err.message}`, ephemeral: true });
    }
}

else if (customId.startsWith('file_delete_')) {
    const rest = customId.replace('file_delete_', '');
    const [botId, encodedPath] = rest.split('::');
    const filePath = decodeFilePath(encodedPath);
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    // Ação destrutiva: exige confirmação, mesmo padrão usado pra excluir bot.
    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_file_delete_${botId}::${encodedPath}`).setLabel('Sim, excluir').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`files_nav_${botId}::${encodeFilePath(path.dirname(filePath) === '.' ? '' : path.dirname(filePath))}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
    );
    await interaction.reply({ content: `⚠️ Tem certeza que deseja excluir \`${filePath}\`? Isso não pode ser desfeito pelo painel.`, components: [confirmRow], ephemeral: true });
}

else if (customId.startsWith('confirm_file_delete_')) {
    const rest = customId.replace('confirm_file_delete_', '');
    const [botId, encodedPath] = rest.split('::');
    const filePath = decodeFilePath(encodedPath);
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    try {
        deleteItem(bot.folder_path, filePath);
        logAction(botId, interaction.user.id, 'CONFIG', `Excluído: ${filePath}`);
        await interaction.reply({ content: `${config.emojis.success} \`${filePath}\` excluído!`, ephemeral: true });
    } catch (err) {
        await interaction.reply({ content: `${config.emojis.error} Erro: ${err.message}`, ephemeral: true });
    }
}

else if (customId.startsWith('bot_delete_')) {
    const botId = customId.replace('bot_delete_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'delete')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para excluir este bot.`, ephemeral: true });
    }

    // CORREÇÃO CRÍTICA: excluir era uma ação de 1 clique só, sem NENHUMA
    // confirmação, para uma ação destrutiva e irreversível (apaga processo,
    // pasta no disco e registro no banco). Um clique acidental perdia o bot
    // do cliente pra sempre. Agora exige confirmação explícita.
    const confirmEmbed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle(`⚠️ Confirmar Exclusão`)
        .setDescription(
            `Tem certeza que deseja excluir **${bot.name}** permanentemente?\n\n` +
            `Isso vai parar o processo, apagar todos os arquivos do bot e remover seu registro. ` +
            `Um backup de segurança será feito automaticamente antes da exclusão, mas essa ação não pode ser desfeita pelo painel.`
        );
    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_delete_${botId}`).setLabel('Sim, excluir permanentemente').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`bot_panel_${botId}`).setLabel('Cancelar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({ embeds: [confirmEmbed], components: [confirmRow], ephemeral: true });
}

else if (customId.startsWith('confirm_delete_')) {
    const botId = customId.replace('confirm_delete_', '');
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado (talvez já tenha sido excluído).', ephemeral: true });
    // Rechecagem de permissão: o botão de confirmação carrega o mesmo botId,
    // então vale a pena confirmar de novo que quem clicou ainda pode excluir.
    if (!canManageBot(interaction.user.id, bot, 'delete')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para excluir este bot.`, ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    // Backup de segurança automático antes de apagar tudo (se der erro no
    // backup, seguimos com a exclusão mesmo assim, mas avisamos o usuário).
    let backupWarning = '';
    try {
        const { createBackup } = require('../../managers/backupManager');
        await createBackup(botId, 'pre-delete');
    } catch (err) {
        backupWarning = `\n⚠️ Não foi possível criar o backup de segurança antes de excluir: ${err.message}`;
    }

    // CORREÇÃO: antes apagava a pasta do disco imediatamente após mandar
    // parar o processo, sem esperar ele realmente sair — o processo do bot
    // podia ainda estar rodando e tentando ler seus próprios arquivos no
    // meio do desligamento. Agora espera até 6s o processo sair de fato.
    if (bot.status === 'online') {
        stopBot(botId);
        const deadline = Date.now() + 6000;
        const { activeProcesses } = require('../../managers/processManager');
        while (Date.now() < deadline && activeProcesses.has(botId)) {
            await new Promise(r => setTimeout(r, 250));
        }
    }

    // Remove pasta do disco
    if (fs.existsSync(bot.folder_path)) {
        fs.rmSync(bot.folder_path, { recursive: true, force: true });
    }

    // Remove do banco (cascade deleta logs, backups e env_variables)
    run('DELETE FROM bots WHERE id = ?', [botId]);
    logAction(botId, interaction.user.id, 'DELETE', `Bot excluído: ${bot.name}`);
    logUserAction(interaction.user.id, botId, 'DELETE_BOT', `Excluiu bot ${bot.name}`);

    await interaction.editReply({ content: `${config.emojis.success} Bot **${bot.name}** excluído permanentemente.${backupWarning}` });
}

// ======================================================================
// CONFIGURAÇÕES DO SISTEMA
// ======================================================================

    return true;
}

module.exports = { match, handle };
