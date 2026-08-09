/**
 * Helpers de UI compartilhados entre interactionHandler e domains
 */
const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder,
} = require('discord.js');
const { get } = require('../database/database');
const config = require('../../config');
const { canManageBot, hasPermission } = require('../managers/userManager');
const { logSecurityEvent } = require('../managers/logManager');
const { listFiles } = require('../managers/fileManager');
const { decrypt, maskToken } = require('../utils/crypto');
const { formatDate, formatBytes } = require('../utils/format');
const { getHealthDisplay } = require('../managers/healthManager');

function encodeFilePath(p) {
    return Buffer.from(p || '', 'utf8').toString('base64url');
}
function decodeFilePath(encoded) {
    if (!encoded) return '';
    return Buffer.from(encoded, 'base64url').toString('utf8');
}

/**
 * NOVA FEATURE: Gerenciador de Arquivos completo. Antes "Arquivos" só listava
 * o conteúdo da pasta raiz do bot, sem navegação, sem criar/editar/renomear/
 * excluir nada pela UI (as funções já existiam em fileManager.js, mas nunca
 * tinham sido conectadas a botões de verdade).
 */
async function showFileBrowser(interaction, botId, subpath) {
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'view')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para ver os arquivos deste bot.`, ephemeral: true });
    }

    let files;
    try {
        files = listFiles(bot.folder_path, subpath);
    } catch (err) {
        return interaction.reply({ content: `${config.emojis.error} Erro ao listar arquivos: ${err.message}`, ephemeral: true });
    }

    const encodedSubpath = encodeFilePath(subpath);
    const embed = new EmbedBuilder()
        .setColor(config.bot.color)
        .setTitle(`${config.emojis.files} Arquivos — ${bot.name}`)
        .setDescription(`📍 \`/${subpath}\`\n\n${files.length === 0 ? '*(pasta vazia)*' : files.map(f => `${f.isDirectory ? '📁' : '📄'} **${f.name}**${!f.isDirectory ? ` (${formatBytes(f.size)})` : ''}`).join('\n')}`);

    const components = [];

    // Select menu de navegação (só entra se houver itens — Discord não aceita select vazio)
    if (files.length > 0) {
        const options = files.slice(0, 25).map(f => ({
            label: f.name.substring(0, 100),
            value: `${f.isDirectory ? 'd' : 'f'}:${encodeFilePath(subpath ? `${subpath}/${f.name}` : f.name)}`,
            emoji: f.isDirectory ? '📁' : '📄',
        }));
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`files_select_${botId}::${encodedSubpath}`)
                .setPlaceholder('Selecione um arquivo ou pasta...')
                .addOptions(options)
        ));
    }

    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`files_create_file_${botId}::${encodedSubpath}`).setLabel('Novo Arquivo').setEmoji('📄').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`files_create_folder_${botId}::${encodedSubpath}`).setLabel('Nova Pasta').setEmoji('📁').setStyle(ButtonStyle.Secondary)
    );
    if (subpath) {
        const parent = path.dirname(subpath);
        navRow.addComponents(
            new ButtonBuilder().setCustomId(`files_nav_${botId}::${encodeFilePath(parent === '.' ? '' : parent)}`).setLabel('Subir').setEmoji('⬆️').setStyle(ButtonStyle.Secondary)
        );
    }
    navRow.addComponents(
        new ButtonBuilder().setCustomId(`bot_panel_${botId}`).setLabel('Voltar ao Painel').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary)
    );
    components.push(navRow);

    if (interaction.isStringSelectMenu() || interaction.isButton()) {
        await interaction.update({ embeds: [embed], components }).catch(() => interaction.reply({ embeds: [embed], components, ephemeral: true }));
    } else {
        await interaction.reply({ embeds: [embed], components, ephemeral: true });
    }
}

/**
 * Mostra as ações disponíveis para um arquivo específico (Ver, Baixar,
 * Renomear, Excluir).
 */
async function showFileActions(interaction, botId, filePath, parentSubpath) {
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'view')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    const encodedPath = encodeFilePath(filePath);
    const embed = new EmbedBuilder()
        .setColor(config.bot.color)
        .setTitle(`📄 ${path.basename(filePath)}`)
        .setDescription(`Caminho: \`/${filePath}\`\n\nO que deseja fazer?`);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`file_view_${botId}::${encodedPath}`).setLabel('Ver Conteúdo').setEmoji('👁️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`file_download_${botId}::${encodedPath}`).setLabel('Baixar').setEmoji('⬇️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`file_rename_${botId}::${encodedPath}`).setLabel('Renomear').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`file_delete_${botId}::${encodedPath}`).setLabel('Excluir').setEmoji('🗑️').setStyle(ButtonStyle.Danger)
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`files_nav_${botId}::${encodeFilePath(parentSubpath)}`).setLabel('Voltar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({ embeds: [embed], components: [row1, row2] });
}

async function showBotPanel(interaction, botId) {
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    // CORREÇÃO CRÍTICA (IDOR): sem esta checagem, qualquer usuário que soubesse o ID
    // de um bot alheio conseguia ver o painel completo (status, RAM/CPU, criador etc.)
    if (!canManageBot(interaction.user.id, bot)) {
        logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou ver o painel do bot ${botId} sem permissão`);
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para ver este bot.`, ephemeral: true });
    }

    let extraInfo = '';
    if (bot.type === 'web') {
        extraInfo = `**Domínio:** \`${bot.domain || 'Não configurado'}\`\n` +
                    `**Porta:** \`${bot.port || 'N/A'}\`\n`;
    } else if (bot.type === 'minecraft') {
        extraInfo = `**Versão:** \`${bot.minecraft_version || 'N/A'}\` (${bot.server_type || 'Paper'})\n` +
                    `**IP:** \`${config.system.ip || '127.0.0.1'}:${bot.port || 25565}\`\n`;
    } else {
        extraInfo = `**Linguagem:** \`${bot.language || 'javascript'}\`\n` +
                    `**Arquivo Principal:** \`${bot.main_file || 'index.js'}\`\n`;
    }

    const embed = new EmbedBuilder()
        .setColor(bot.suspended ? '#FF0000' : config.bot.color)
        .setTitle(`${bot.status === 'online' ? config.emojis.powerOn : config.emojis.powerOff} [${bot.type.toUpperCase()}] ${bot.name}${bot.suspended ? ' 🚫 SUSPENSO' : ''}`)
        .setDescription(
            (bot.suspended ? `**⚠️ Este bot está suspenso${bot.suspended_reason ? `: ${bot.suspended_reason}` : '.'}**\n\n` : '') +
            `**Código:** \`${bot.code}\`\n` +
            `**Status:** \`${bot.status}\`\n` +
            `**RAM:** \`${bot.ram_usage || 0}MB\`\n` +
            `**CPU:** \`${bot.cpu_usage || 0}%\`\n` +
            extraInfo +
            `**Saúde:** \`${bot.health_status || 'healthy'}\` (Score: ${bot.health_score || 100})\n` +
            `**Auto Restart:** \`${bot.auto_restart ? 'Sim' : 'Não'}\`\n` +
            `**Última atividade:** \`${formatDate(bot.last_activity)}\``
        );

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bot_start_${botId}`).setLabel('Ligar').setEmoji('▶').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`bot_stop_${botId}`).setLabel('Desligar').setEmoji('⏹').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`bot_restart_${botId}`).setLabel('Reiniciar').setEmoji('🔄').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`bot_logs_${botId}`).setLabel('Logs').setEmoji('📜').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bot_stats_${botId}`).setLabel('Estatísticas').setEmoji('📊').setStyle(ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`config_edit_name_${botId}`).setLabel('Config').setEmoji('⚙').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bot_files_${botId}`).setLabel('Arquivos').setEmoji('📂').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bot_backup_${botId}`).setLabel('Backup').setEmoji('💾').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bot_clone_${botId}`).setLabel('Clonar').setEmoji('📑').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`bot_delete_${botId}`).setLabel('Excluir').setEmoji('🗑').setStyle(ButtonStyle.Danger)
    );

    // CORREÇÃO (feature inacessível): a gestão de colaboradores (adicionar/
    // remover, ver 'bot_collabs_' no handler) já existia implementada, mas
    // nenhum botão em lugar nenhum da UI levava até ela — só era alcançável
    // digitando o customId manualmente. Só o dono do bot vê este botão (faz
    // sentido: só o dono pode conceder acesso a colaboradores).
    const rowTeam = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bot_collabs_${botId}`).setLabel('Equipe').setEmoji('👥').setStyle(ButtonStyle.Secondary)
    );

    const components = bot.creator_id === interaction.user.id ? [row1, row2, rowTeam] : [row1, row2];

    // Linha de GitHub: só aparece se o bot tiver um repositório configurado.
    if (bot.github_repo) {
        const rowGithub = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`bot_github_update_${botId}`).setLabel('Atualizar').setEmoji('⬇️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`bot_github_branch_${botId}`).setLabel('Trocar Branch').setEmoji('🌿').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`bot_github_rollback_${botId}`).setLabel('Rollback').setEmoji('⏪').setStyle(ButtonStyle.Danger)
        );
        components.push(rowGithub);
    }

    // Linha de moderação: só aparece pra quem tem permissão de staff (moderator+),
    // já que suspender é uma ação de fiscalização, não algo que o dono faz em si mesmo.
    if (hasPermission(interaction.user.id, 'moderator')) {
        const row3 = new ActionRowBuilder().addComponents(
            bot.suspended
                ? new ButtonBuilder().setCustomId(`bot_unsuspend_${botId}`).setLabel('Reativar (Staff)').setEmoji('✅').setStyle(ButtonStyle.Success)
                : new ButtonBuilder().setCustomId(`bot_suspend_${botId}`).setLabel('Suspender (Staff)').setEmoji('🚫').setStyle(ButtonStyle.Danger)
        );
        components.push(row3);
    }

    if (interaction.isStringSelectMenu()) {
        await interaction.update({ embeds: [embed], components });
    } else {
        await interaction.reply({ embeds: [embed], components, ephemeral: true });
    }
}

/**
 * Mostra o painel de configuração de um bot específico
 * CORREÇÃO: decrypt agora importado corretamente
 */
async function showConfigPanel(interaction, botId) {
    const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
    if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
    if (!canManageBot(interaction.user.id, bot, 'config')) {
        return interaction.reply({ content: `${config.emojis.error} Você não tem permissão.`, ephemeral: true });
    }

    // CORREÇÃO CRÍTICA: decrypt estava sendo chamado sem estar importado
    const rawToken = decrypt(bot.token);

    const embed = new EmbedBuilder()
        .setColor(config.bot.color)
        .setTitle(`${config.emojis.configBot} Configurar — ${bot.name}`)
        .setDescription(
            `**Nome:** \`${bot.name}\`\n` +
            `**Descrição:** \`${bot.description || 'N/A'}\`\n` +
            `**Linguagem:** \`${bot.language || 'javascript'}\`\n` +
            `**Arquivo Principal:** \`${bot.main_file || 'index.js'}\`\n` +
            `**Auto Restart:** \`${bot.auto_restart ? 'Sim' : 'Não'}\`\n` +
            `**Node Version:** \`${bot.node_version || '18'}\`\n` +
            `**Python Version:** \`${bot.python_version || '3'}\`\n` +
            `**Memória Máx:** \`${bot.max_memory || 'N/A'}MB\`\n` +
            `**CPU Máx:** \`${bot.max_cpu_limit || 'N/A'}%\`\n` +
            `**Token:** \`${maskToken(rawToken)}\``
        );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`config_edit_name_${botId}`).setLabel('Editar Nome').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`config_edit_desc_${botId}`).setLabel('Editar Desc').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`config_edit_token_${botId}`).setLabel('Editar Token').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`config_toggle_restart_${botId}`).setLabel('Auto Restart').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`config_delete_${botId}`).setLabel('Excluir').setEmoji(config.emojis.delete).setStyle(ButtonStyle.Danger)
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`config_edit_runtime_${botId}`).setLabel('Editar Versão do Runtime').setEmoji('🧩').setStyle(ButtonStyle.Secondary)
    );

    await interaction.update({ embeds: [embed], components: [row, row2] });
}

module.exports = {
    encodeFilePath,
    decodeFilePath,
    showFileBrowser,
    showFileActions,
    showBotPanel,
    showConfigPanel,
};
