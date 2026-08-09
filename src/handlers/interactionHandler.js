/**
 * HANDLER DE INTERAÇÕES
 * Gerencia todos os botões, modais, selects e menus do sistema
 *
 * Correções aplicadas:
 * - decrypt importado corretamente (bug crítico: crash ao abrir config do bot)
 * - awaitMessages filtra por autor (qualquer usuário não pode mais enviar o ZIP)
 * - modal_add_file faz deferReply antes de operações lentas
 * - back_to_panel usa deferUpdate + editReply corretamente
 * - template literal quebrado na linha de Ping corrigido
 * - uptime do processo formatado com formatProcessUptime (não quebra > 24h)
 * - config_bot_list passa embed para não quebrar em update
 * - Botões de config implementados: editar nome, desc, token, toggle restart, excluir
 * - Token regex atualizada para aceitar tokens modernos do Discord
 * - Validação de nome e descrição (tamanho máximo)
 */
const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    StringSelectMenuBuilder, AttachmentBuilder,
    ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { query, get, run } = require('../database/database');
const { encrypt, decrypt, maskToken } = require('../utils/crypto');
const { generateBotCode, generateId } = require('../utils/codeGenerator');
const { formatBytes, formatUptime, formatDate, formatProcessUptime } = require('../utils/format');
const { startBot, stopBot, restartBot, getBotLogs, getSystemStats, getBotStats } = require('../managers/processManager');
const { logAction, logUserAction, logSecurityEvent } = require('../managers/logManager');
const { createBackup, restoreBackup, listBackups } = require('../managers/backupManager');
const { listFiles, readFile, writeFile, createFolder, deleteItem, renameItem, copyFolderRecursive } = require('../managers/fileManager');
const { getUser, hasPermission, canManageBot, registerUser } = require('../managers/userManager');
const { installDependencies } = require('../managers/dependencyManager');
const { getRecentLogs } = require('../managers/consoleManager');
const { analyzeBotLogs } = require('../managers/diagnosticManager');
const { getHealthDisplay } = require('../managers/healthManager');
const { canAddBot, getUserPlanInfo, getAllPlans, getPlan } = require('../managers/planManager');
const { getAvailablePort, releasePort } = require('../managers/portManager');
const { createOrder, getOrderByChannel, updateOrderPlan, applyCouponToOrder, updateOrderStatus } = require('../managers/orderManager');
const { validateCoupon, incrementCouponUse } = require('../managers/couponManager');
const { checkRateLimit, formatRetryAfter } = require('../utils/rateLimiter');
const { detectLanguageAndMainFile, flattenSingleSubfolder } = require('../utils/languageDetector');
const { detectLanguageWithAI } = require('../managers/diagnosticManager');
const config = require('../../config');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { validateZipEntries } = require('../utils/zipValidation');
const { routeDomain } = require('./domains');
const { showBotPanel, showConfigPanel, showFileBrowser, showFileActions, encodeFilePath, decodeFilePath } = require('./panelHelpers');

// ── ANTI-SPAM (COOLDOWN) ───────────────────────────────────────────────────────
const cooldowns = new Map();

function checkCooldown(userId) {
    const now = Date.now();
    const last = cooldowns.get(userId) || 0;
    if (now - last < config.security.antiSpamCooldown) return false;
    cooldowns.set(userId, now);
    return true;
}

// ── REGEX DE TOKEN DO DISCORD ─────────────────────────────────────────────────
// Aceita tokens modernos (incluindo bot tokens com prefixo MTA, OTk, etc.)
const TOKEN_REGEX = /^[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}$/;

/**
 * Cria um bot a partir de um anexo ZIP já validado (nome, token, descrição e
 * o attachment do Discord). Extraído para uma função própria porque essa
 * mesma lógica (download, validação anti zip-slip, extração, detecção de
 * linguagem, insert no banco, instalação de dependências) é usada tanto pelo
 * fluxo normal (modal_add_file) quanto pelo Quick Deploy — antes só existia
 * no fluxo normal, e reimplementar do zero pro Quick Deploy arriscaria
 * duplicar (e divergir) uma lógica sensível a segurança (zip-slip).
 *
 * @returns {Promise<{success:boolean, botId?:string, code?:string, language?:string, mainFile?:string, name?:string, error?:string}>}
 */
async function deployBotFromZip({ userId, name, token, description, attachment, onDownloaded }) {
    const maxBytes = config.security.maxFileSizeMB * 1024 * 1024;
    if (attachment.size > maxBytes) {
        return { success: false, error: `Arquivo maior que o limite de ${config.security.maxFileSizeMB}MB.` };
    }

    const botId = generateId();
    const code = generateBotCode('BOT');

    const { getBestNode } = require('../managers/nodeManager');
    const nodeId = getBestNode();

    const folderPath = path.resolve(config.system.botsFolder, botId);
    const tempZipPath = path.join(config.system.botsFolder, `_upload_${botId}.zip`);

    try {
        // CORREÇÃO CRÍTICA: antes a mensagem com o anexo era apagada ANTES deste
        // fetch (pensando que a URL do CDN da Discord continuaria válida por um
        // tempo). Na prática não é bem assim — a Discord costuma invalidar/
        // recusar o download quase imediatamente depois que a mensagem de
        // origem é apagada, o que fazia esse fetch falhar quase toda vez com
        // "Falha ao baixar o anexo do Discord." (bug real reportado em produção).
        // Agora baixamos primeiro e só then avisamos o chamador (via
        // onDownloaded) que já pode apagar a mensagem com segurança — a
        // exposição pública continua sendo de segundos, só que depois de
        // confirmarmos que o download já terminou.
        const res = await fetch(attachment.url);
        if (!res.ok) throw new Error(`Falha ao baixar o anexo do Discord (HTTP ${res.status}).`);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(tempZipPath, buffer);

        if (onDownloaded) await onDownloaded().catch(() => {});

        const zip = new AdmZip(tempZipPath);
        const entries = zip.getEntries();
        const destRoot = path.resolve(folderPath);

        // Zip-slip + zip bomb: ver src/utils/zipValidation.js (extraído daqui
        // pra ser testável isoladamente, ver tests/zipValidation.test.js)
        validateZipEntries(entries, destRoot, {
            maxEntries: config.security.maxZipEntries,
            maxUnzippedSizeMB: config.security.maxUnzippedSizeMB,
        });

        fs.mkdirSync(folderPath, { recursive: true });
        zip.extractAllTo(folderPath, true);

        let { language, mainFile, searchRoot } = detectLanguageAndMainFile(folderPath);
        let detectedByAI = false;

        // NOVA FEATURE: quando a detecção normal (procurar index.js/main.py etc.)
        // não acha nada, pedimos pra IA da Groq analisar a estrutura de arquivos
        // e tentar identificar sozinha. A sugestão da IA é sempre revalidada
        // (o arquivo precisa existir de verdade dentro da pasta) antes de ser
        // usada — nunca confiamos cegamente no que a IA responde.
        // Guarda o framework detectado pela IA (se houve) só para exibição —
        // não é persistido no banco pois não há coluna pra isso ainda, mas
        // ajuda o usuário a confirmar que a detecção fez sentido.
        let detectedFramework = null;
        if (!mainFile) {
            const aiResult = await detectLanguageWithAI(searchRoot);
            if (aiResult.success) {
                language = aiResult.language;
                mainFile = aiResult.mainFile;
                detectedByAI = true;
                detectedFramework = aiResult.framework;
            } else {
                fs.rmSync(folderPath, { recursive: true, force: true });
                return {
                    success: false,
                    error: `Nenhum arquivo principal encontrado automaticamente (index.js, main.js, main.py, bot.py...), e a detecção por IA também não conseguiu: ${aiResult.reason}`
                };
            }
        }

        flattenSingleSubfolder(folderPath, searchRoot);

        run(
            `INSERT INTO bots (id, code, name, description, token, language, main_file, creator_id, folder_path, status, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [botId, code, name, description, encrypt(token), language, mainFile, userId, folderPath, 'offline', nodeId]
        );

        logAction(botId, userId, 'ADD', `Bot adicionado via arquivo ZIP: ${name}${detectedByAI ? ' (linguagem detectada por IA)' : ''}`);
        logUserAction(userId, botId, 'ADD_BOT', `Adicionou bot ${name} (${code}) via ZIP`);

        // Instalação de dependências em background — retornamos a promise para
        // que cada chamador notifique o resultado do jeito certo (followUp na
        // interação normal, ou mensagem na thread do Quick Deploy).
        const installPromise = installDependencies(botId, folderPath);

        return { success: true, botId, code, language, mainFile, name, installPromise, detectedByAI, detectedFramework };
    } catch (err) {
        if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true });
        return { success: false, error: err.message };
    } finally {
        if (fs.existsSync(tempZipPath)) {
            try { fs.unlinkSync(tempZipPath); } catch { /* Ignora */ }
        }
    }
}

/**
 * Monta o embed e os botões do painel principal
 */
async function buildMainPanelEmbed(interaction) {
    const stats = await getSystemStats();
    const totalBots = get('SELECT COUNT(*) as count FROM bots').count;
    const onlineBots = get("SELECT COUNT(*) as count FROM bots WHERE status = 'online'").count;
    const offlineBots = totalBots - onlineBots;
    const now = new Date();
    const plan = getUserPlanInfo(interaction.user.id);

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
            `**${config.emojis.settings} Versão:** \`v${config.bot.version}\`\n\n` +
            `**${config.emojis.lock} Dono do Painel:** <@${config.bot.ownerId}>\n` +
            `**${config.emojis.category} Data:** \`${now.toLocaleDateString('pt-BR')}\`\n` +
            `**${config.emojis.uptime} Hora:** \`${now.toLocaleTimeString('pt-BR')}\`\n\n` +
            `**💳 Seu Plano:** \`${plan.name}\` (\`${plan.currentBots}/${plan.maxBots}\` bots)`
        )
        .setFooter({ text: `Solicitado por ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
        .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('add_bot').setLabel('Adicionar Bot').setEmoji(config.emojis.add).setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('start_bots').setLabel('Start Bots').setEmoji(config.emojis.start).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('my_bots').setLabel('Meus Bots').setEmoji(config.emojis.myBots).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('settings').setLabel('Configurações').setEmoji(config.emojis.settings).setStyle(ButtonStyle.Secondary)
    );

    return { embed, row };
}

/**
 * Roda o assistente de Quick Deploy dentro de uma thread privada: coleta
 * nome -> token -> zip em sequência e cria o bot ao final.
 *
 * CORREÇÃO (feature quebrada): antes o botão "Quick Deploy" criava a thread
 * e mandava as instruções, mas NADA processava as mensagens que o usuário
 * enviava em resposta — a thread simplesmente não fazia nada, apesar de
 * anunciar um wizard de 3 passos. Esta função implementa o wizard de verdade,
 * reaproveitando a mesma validação de ZIP (anti zip-slip) usada no fluxo normal.
 */
async function runQuickDeployWizard(thread, user) {
    const STEP_TIMEOUT = 120000; // 2 minutos por etapa, como anunciado no embed
    const filterAuthor = (m) => m.author.id === user.id;

    async function collectText(prompt) {
        await thread.send(prompt);
        const collected = await thread.awaitMessages({
            filter: (m) => filterAuthor(m) && m.content.trim().length > 0,
            max: 1,
            time: STEP_TIMEOUT,
            errors: ['time'],
        });
        return collected.first().content.trim();
    }

    try {
        // 1. Nome
        let name = await collectText('**Passo 1/3:** Digite o **nome** do seu bot (até 32 caracteres).');
        if (name.length > 32) name = name.substring(0, 32);

        // 2. Token (até 3 tentativas dentro do fluxo, sem reiniciar a thread inteira)
        let token = null;
        for (let attempt = 1; attempt <= 3 && !token; attempt++) {
            const raw = await collectText(
                attempt === 1
                    ? '**Passo 2/3:** Agora envie o **token** do seu bot.'
                    : `❌ Token inválido. Tente novamente (tentativa ${attempt}/3).`
            );
            if (TOKEN_REGEX.test(raw.trim())) token = raw.trim();
        }
        if (!token) {
            await thread.send(`${config.emojis.error} Token inválido demais vezes. Deploy cancelado.`);
            return;
        }

        // 3. ZIP
        await thread.send(`**Passo 3/3:** Envie agora o arquivo **.zip** do seu bot (máximo ${config.security.maxFileSizeMB}MB).`);
        const collected = await thread.awaitMessages({
            filter: (m) => filterAuthor(m) && m.attachments.size > 0,
            max: 1,
            time: STEP_TIMEOUT,
            errors: ['time'],
        });
        const zipMessage = collected.first();
        const attachment = zipMessage.attachments.first();

        if (!attachment.name.toLowerCase().endsWith('.zip')) {
            await zipMessage.delete().catch(() => {});
            await thread.send(`${config.emojis.error} O arquivo precisa ser um \`.zip\`. Deploy cancelado.`);
            return;
        }

        await thread.send(`${config.emojis.warning} Processando seu bot, aguarde...`);

        // CORREÇÃO: apagar ANTES do download quebrava o fetch (ver comentário
        // detalhado em deployBotFromZip). Agora só apagamos depois que o
        // download já terminou de verdade, via callback onDownloaded.
        const result = await deployBotFromZip({
            userId: user.id, name, token, description: '', attachment,
            onDownloaded: () => zipMessage.delete().catch(() => {}),
        });

        if (!result.success) {
            await thread.send(`${config.emojis.error} Erro ao processar o ZIP: ${result.error}`);
            return;
        }

        await thread.send(
            `${config.emojis.success} **Bot adicionado com sucesso!**\n` +
            `**Nome:** \`${result.name}\`\n` +
            `**Código:** \`${result.code}\`\n` +
            `**Linguagem:** \`${result.language}\`${result.detectedByAI ? ' 🧠 *(detectada por IA)*' : ''}\n\n` +
            `Use o código \`${result.code}\` no painel para gerenciá-lo. Esta thread será excluída em instantes.`
        );

        // CORREÇÃO: antes a thread era apagada (agora de verdade — ver comentário
        // no finally) só 10s depois desta mensagem, sem esperar a instalação de
        // dependências terminar — o aviso de sucesso/falha da instalação quase
        // nunca chegava a ser visto porque a thread já tinha sumido. Esperamos o
        // resultado (com um teto de segurança) antes de deixar o finally apagar.
        try {
            const success = await Promise.race([
                result.installPromise,
                new Promise((resolve) => setTimeout(() => resolve(null), 90000)), // teto de 90s
            ]);
            if (success !== null) {
                await thread.send(success
                    ? `${config.emojis.success} Dependências instaladas com sucesso!`
                    : `${config.emojis.warning} Falha ao instalar dependências. Verifique os logs no console do bot.`
                ).catch(() => {});
            }
        } catch { /* instalação falhou de forma inesperada — já logado no console do bot */ }
    } catch {
        // Timeout de alguma das etapas (awaitMessages rejeita com 'time')
        await thread.send(`${config.emojis.warning} Tempo esgotado por inatividade. Deploy cancelado.`).catch(() => {});
    } finally {
        // CORREÇÃO: o embed do passo 1 promete "esta thread será excluída", mas
        // o código só arquivava (setArchived) — uma thread arquivada continua
        // existindo e legível por qualquer um com acesso ao canal, não é
        // excluída de verdade. Agora cumprimos a promessa e apagamos mesmo.
        setTimeout(() => thread.delete().catch(() => {}), 10000);
    }
}

// ── HANDLER PRINCIPAL ──────────────────────────────────────────────────────────
async function handleInteraction(interaction) {
    if (!interaction.isButton() && !interaction.isModalSubmit() && !interaction.isStringSelectMenu()) return;

    if (!checkCooldown(interaction.user.id)) {
        return interaction.reply({
            content: `${config.emojis.warning} Aguarde um pouco antes de clicar novamente.`,
            ephemeral: true,
        });
    }

    const customId = interaction.customId;

    try {
        // CORREÇÃO CRÍTICA DE VERDADE: registerUser nunca era chamado aqui — só
        // em /painel, /criar-painel-vendas e no fluxo de compra (sales.js).
        // Qualquer pessoa que clicasse em QUALQUER botão (Adicionar Bot,
        // Clonar, Adicionar Colaborador, etc.) num painel que OUTRA pessoa
        // postou, sem nunca ter rodado /painel ela mesma, batia direto no
        // mesmo "FOREIGN KEY constraint failed" que a gente corrigiu nos
        // pedidos — só que aqui em pelo menos 5 fluxos diferentes (criar bot
        // por ZIP, por GitHub, Quick Deploy, clonar bot, adicionar
        // colaborador). Registrar aqui, uma vez só, no topo, cobre todos eles
        // de uma vez — é idempotente, então não tem custo real em repetir.
        registerUser(interaction.user);

        // ── ROUTER DE DOMÍNIOS (sales / affiliate / admin modular) ──
        if (await routeDomain(interaction, { hasPermission, logSecurityEvent, checkRateLimit, formatRetryAfter })) {
            return;
        }

        // sales/admin/affiliate/bots/files → routeDomain acima

        // ======================================================================
        // PAINEL PRINCIPAL
        // ======================================================================

        if (customId === 'add_bot') {
            const embed = new EmbedBuilder()
                .setColor(config.bot.color)
                .setTitle(`${config.emojis.add} Nova Hospedagem`)
                .setDescription(
                    `Escolha o **tipo** do que você quer hospedar:\n\n` +
                    `🤖 **Bot Discord** — bot com token (Discord.js / discord.py)\n` +
                    `🌐 **Site / App** — site, API ou aplicação web (Node.js)\n\n` +
                    `Depois você poderá enviar ZIP, colar token (bots) ou usar o template pronto.`
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('back_to_panel').setLabel('Voltar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('add_type_bot').setLabel('Bot Discord').setEmoji('🤖').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('add_type_web').setLabel('Site / App').setEmoji('🌐').setStyle(ButtonStyle.Success),
            );

            await interaction.update({ embeds: [embed], components: [row] });
        }

        // ── Tipo: Bot Discord ────────────────────────────────────────────────
        else if (customId === 'add_type_bot') {
            const embed = new EmbedBuilder()
                .setColor(config.bot.color)
                .setTitle(`${config.emojis.add} Adicionar Bot Discord`)
                .setDescription(
                    `**Formatos aceitos:**\n` +
                    `- JavaScript (Discord.js) — \`index.js\` / \`main.js\`\n` +
                    `- Python (discord.py) — \`main.py\` / \`bot.py\`\n\n` +
                    `**Requisitos:** token válido, arquivo principal na raiz do ZIP.\n` +
                    `Máximo **${config.security.maxFileSizeMB}MB** por arquivo.`
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('add_bot').setLabel('Voltar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('add_bot_modal').setLabel('Com Token').setEmoji(config.emojis.addBot).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('add_via_file').setLabel('Via ZIP').setEmoji('📦').setStyle(ButtonStyle.Secondary),
            );

            await interaction.update({ embeds: [embed], components: [row] });
        }

        // ── Tipo: Site / App ─────────────────────────────────────────────────
        else if (customId === 'add_type_web') {
            const embed = new EmbedBuilder()
                .setColor('#00B894')
                .setTitle('🌐 Hospedar Site / App')
                .setDescription(
                    `Crie uma hospedagem web (site, API Express, etc.).\n\n` +
                    `**O que você ganha:**\n` +
                    `- Pasta própria + template Node pronto\n` +
                    `- Porta automática alocada\n` +
                    `- Start / Stop / Logs / Arquivos no painel\n\n` +
                    `**Dica:** no código use \`process.env.PORT\`.\n` +
                    `Sem domínio, acesse pelo IP do host + porta.`
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('add_bot').setLabel('Voltar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('add_web_modal').setLabel('Criar Site/App').setEmoji('🚀').setStyle(ButtonStyle.Success),
            );

            await interaction.update({ embeds: [embed], components: [row] });
        }

        else if (customId === 'add_web_modal') {
            const modal = new ModalBuilder()
                .setCustomId('modal_add_web')
                .setTitle('Criar Site / App')
                .addComponents(
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('web_name')
                            .setLabel('Nome do projeto')
                            .setStyle(TextInputStyle.Short)
                            .setPlaceholder('Meu Site')
                            .setMinLength(1)
                            .setMaxLength(32)
                            .setRequired(true)
                    ),
                    new ActionRowBuilder().addComponents(
                        new TextInputBuilder()
                            .setCustomId('web_desc')
                            .setLabel('Descrição (opcional)')
                            .setStyle(TextInputStyle.Paragraph)
                            .setPlaceholder('API, landing page, dashboard...')
                            .setMaxLength(200)
                            .setRequired(false)
                    )
                );
            await interaction.showModal(modal);
        }

        else if (customId === 'modal_add_web') {
            const name = interaction.fields.getTextInputValue('web_name').trim();
            const description = interaction.fields.getTextInputValue('web_desc')?.trim() || '';

            if (!canAddBot(interaction.user.id)) {
                const plan = getUserPlanInfo(interaction.user.id);
                return interaction.reply({
                    content: `${config.emojis.error} Limite do plano **${plan.name}** (${plan.maxBots}). Faça upgrade!`,
                    ephemeral: true
                });
            }

            const deployLimit = checkRateLimit(`deploy:${interaction.user.id}`, 5, 60 * 60 * 1000);
            if (!deployLimit.allowed) {
                return interaction.reply({
                    content: `${config.emojis.error} Limite de criação atingido. Tente em ${formatRetryAfter(deployLimit.retryAfterMs)}.`,
                    ephemeral: true
                });
            }

            let port;
            try {
                port = getAvailablePort('web');
            } catch (e) {
                return interaction.reply({ content: `${config.emojis.error} ${e.message}`, ephemeral: true });
            }

            const botId = generateId();
            const code = generateBotCode('WEB');
            const folderPath = path.resolve(config.system.botsFolder, botId);

            try {
                fs.mkdirSync(folderPath, { recursive: true });
                const mainFile = 'index.js';
                const template = [
                    "const http = require('http');",
                    "const PORT = Number(process.env.PORT) || 3000;",
                    "const server = http.createServer((req, res) => {",
                    "  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });",
                    "  const html = '<!DOCTYPE html><html><body style=\"font-family:system-ui;background:#0f1117;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0\">' +",
                    "    '<div style=\"background:#1a1d27;padding:2rem;border-radius:12px;text-align:center\"><h1>Online</h1><p>Porta ' + PORT + '</p></div></body></html>';",
                    "  res.end(html);",
                    "});",
                    "server.listen(PORT, '0.0.0.0', () => console.log('Listening on ' + PORT));",
                ].join('\n');

                fs.writeFileSync(path.join(folderPath, mainFile), template);
                fs.writeFileSync(
                    path.join(folderPath, 'package.json'),
                    JSON.stringify({
                        name: name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'web-app',
                        main: mainFile,
                        scripts: { start: 'node index.js' }
                    }, null, 2)
                );

                run(
                    `INSERT INTO bots (id, code, name, description, type, language, main_file, port, internal_port, creator_id, folder_path, status, auto_restart)
                     VALUES (?, ?, ?, ?, 'web', 'javascript', ?, ?, ?, ?, ?, 'offline', 1)`,
                    [botId, code, name, description, mainFile, port, port, interaction.user.id, folderPath]
                );
                releasePort(port);

                logAction(botId, interaction.user.id, 'ADD', `Site/App criado: ${name} (porta ${port})`);
                logUserAction(interaction.user.id, botId, 'ADD_WEB', `Criou site/app ${name} (${code}) porta ${port}`);

                const embed = new EmbedBuilder()
                    .setColor('#00B894')
                    .setTitle(`${config.emojis.success} Site / App criado!`)
                    .setDescription(
                        `**Nome:** \`${name}\`\n` +
                        `**Código:** \`${code}\`\n` +
                        `**Tipo:** \`web\`\n` +
                        `**Porta:** \`${port}\`\n` +
                        `**Status:** \`offline\`\n\n` +
                        `Ligue em **Meus Bots** → Start.\n` +
                        `Acesse: \`http://SEU_IP:${port}\``
                    );

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('back_to_panel').setLabel('Voltar ao Painel').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('my_bots').setLabel('Meus Projetos').setEmoji('📁').setStyle(ButtonStyle.Primary),
                );

                await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
            } catch (err) {
                try { releasePort(port); } catch {}
                console.error('Erro ao criar web app:', err);
                return interaction.reply({
                    content: `${config.emojis.error} Falha ao criar: ${err.message}`,
                    ephemeral: true
                });
            }
        }

        else if (customId === 'back_to_panel') {
            await interaction.deferUpdate();
            const { embed, row } = await buildMainPanelEmbed(interaction);

            const bannerPath = path.resolve(config.system.bannerPath);
            if (fs.existsSync(bannerPath)) {
                const attachment = new AttachmentBuilder(bannerPath, { name: 'banner.png' });
                embed.setImage('attachment://banner.png');
                await interaction.editReply({ embeds: [embed], components: [row], files: [attachment] });
            } else {
                await interaction.editReply({ embeds: [embed], components: [row] });
            }
        }

        else if (customId === 'quick_deploy') {
            // Fluxo de Deploy Rápido via Thread Privada (Inspirado no Storm)
            if (!canAddBot(interaction.user.id)) {
                const plan = getUserPlanInfo(interaction.user.id);
                return interaction.reply({ 
                    content: `${config.emojis.error} Você atingiu o limite do seu plano **${plan.name}** (${plan.maxBots} bot). Faça upgrade para adicionar mais!`, 
                    ephemeral: true 
                });
            }

            // Mesma cota compartilhada com os outros dois métodos de criar bot.
            const deployLimitQuick = checkRateLimit(`deploy:${interaction.user.id}`, 5, 60 * 60 * 1000);
            if (!deployLimitQuick.allowed) {
                return interaction.reply({ content: `${config.emojis.error} Limite de criação de bots atingido. Tente novamente em ${formatRetryAfter(deployLimitQuick.retryAfterMs)}.`, ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            try {
                const thread = await interaction.channel.threads.create({
                    name: `deploy-${interaction.user.username}`,
                    autoArchiveDuration: 60,
                    type: ChannelType.PrivateThread,
                    reason: 'Quick Deploy Wizard',
                });

                await thread.members.add(interaction.user.id);

                const embed = new EmbedBuilder()
                    .setColor(config.bot.color)
                    .setTitle(`⚡ Quick Deploy Wizard`)
                    .setDescription(
                        `Bem-vindo ao assistente de deploy rápido!\n\n` +
                        `**Siga os passos abaixo nesta thread:**\n` +
                        `1. Digite o **Nome** do seu bot.\n` +
                        `2. Digite o **Token** do seu bot.\n` +
                        `3. Envie o arquivo **ZIP** do código.\n\n` +
                        `*Esta thread será excluída após a conclusão ou 2 minutos de inatividade.*`
                    );

                await thread.send({ content: `<@${interaction.user.id}>`, embeds: [embed] });

                await interaction.editReply({ 
                    content: `${config.emojis.success} Thread de deploy criada: <#${thread.id}>`,
                    components: [
                        new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ir para Thread').setEmoji('⚡').setURL(`https://discord.com/channels/${interaction.guild.id}/${thread.id}`)
                        )
                    ]
                });

                // Roda o wizard em background — a resposta da interação já foi
                // enviada acima, o resto acontece dentro da thread.
                runQuickDeployWizard(thread, interaction.user).catch((err) => {
                    console.error('Erro no Quick Deploy Wizard:', err);
                    thread.send(`${config.emojis.error} Ocorreu um erro inesperado no assistente.`).catch(() => {});
                });

            } catch (err) {
                console.error('Erro ao criar thread de deploy:', err);
                await interaction.editReply({ content: `${config.emojis.error} Falha ao iniciar o Quick Deploy: ${err.message}` });
            }
        }

        // ======================================================================
        // ADICIONAR BOT — SUB-BOTÕES
        // ======================================================================

        else if (customId === 'add_bot_modal') {
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('add_via_token').setLabel('Token').setEmoji(config.emojis.token).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('add_via_file').setLabel('Arquivo ZIP').setEmoji(config.emojis.file).setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('add_via_github').setLabel('GitHub').setEmoji('🐙').setStyle(ButtonStyle.Primary)
            );
            const embed = new EmbedBuilder()
                .setColor(config.bot.color)
                .setTitle(`${config.emojis.add} Método de Adição`)
                .setDescription(
                    `**Via Token:** Adiciona o bot com um código básico de exemplo.\n` +
                    `**Via Arquivo ZIP:** Envia o código completo do seu bot.\n` +
                    `**Via GitHub:** Clona um repositório público diretamente.\n\n` +
                    `Escolha como deseja adicionar seu bot:`
                );
            await interaction.update({ embeds: [embed], components: [row] });
        }

        else if (customId === 'add_via_token') {
            const modal = new ModalBuilder()
                .setCustomId('modal_add_token')
                .setTitle('Adicionar Bot via Token');

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('bot_token')
                        .setLabel('Token do Bot')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('MTA0...')
                        .setMinLength(50)
                        .setMaxLength(100)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('bot_name')
                        .setLabel('Nome do Bot')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('Meu Bot')
                        .setMinLength(1)
                        .setMaxLength(32)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('bot_desc')
                        .setLabel('Descrição (opcional)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setPlaceholder('Descrição do bot...')
                        .setMaxLength(200)
                        .setRequired(false)
                )
            );

            await interaction.showModal(modal);
        }

        else if (customId === 'modal_add_token') {
            const token = interaction.fields.getTextInputValue('bot_token').trim();
            const name = interaction.fields.getTextInputValue('bot_name').trim();
            const description = interaction.fields.getTextInputValue('bot_desc')?.trim() || '';

            if (!TOKEN_REGEX.test(token)) {
                return interaction.reply({ content: `${config.emojis.error} Token inválido! Verifique o formato.`, ephemeral: true });
            }

            if (!canAddBot(interaction.user.id)) {
                const plan = getUserPlanInfo(interaction.user.id);
                return interaction.reply({ 
                    content: `${config.emojis.error} Você atingiu o limite do seu plano **${plan.name}** (${plan.maxBots} bot). Faça upgrade para adicionar mais!`, 
                    ephemeral: true 
                });
            }

            // Criar bot envolve I/O de disco (pasta + arquivos) e, mais adiante,
            // instalação de dependências (CPU). Sem limite, dava pra automatizar
            // a criação de dezenas de bots em segundos. 5 criações por hora/usuário.
            const deployLimit = checkRateLimit(`deploy:${interaction.user.id}`, 5, 60 * 60 * 1000);
            if (!deployLimit.allowed) {
                return interaction.reply({ content: `${config.emojis.error} Limite de criação de bots atingido. Tente novamente em ${formatRetryAfter(deployLimit.retryAfterMs)}.`, ephemeral: true });
            }

            const botId = generateId();
            const code = generateBotCode('BOT');
            const folderPath = path.resolve(config.system.botsFolder, botId);
            fs.mkdirSync(folderPath, { recursive: true });

            const mainFile = 'index.js';
            const basicCode = [
                `const { Client, GatewayIntentBits } = require('discord.js');`,
                `const client = new Client({ intents: [GatewayIntentBits.Guilds] });`,
                `client.once('ready', () => console.log(\`Bot online como \${client.user.tag}!\`));`,
                `client.login(process.env.DISCORD_TOKEN);`,
            ].join('\n') + '\n';

            fs.writeFileSync(path.join(folderPath, mainFile), basicCode);
            fs.writeFileSync(
                path.join(folderPath, 'package.json'),
                JSON.stringify({ name: name.toLowerCase().replace(/\s+/g, '-'), main: mainFile, dependencies: { 'discord.js': '^14.0.0' } }, null, 2)
            );

            run(
                `INSERT INTO bots (id, code, name, description, token, language, main_file, creator_id, folder_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [botId, code, name, description, encrypt(token), 'javascript', mainFile, interaction.user.id, folderPath, 'offline']
            );

            logAction(botId, interaction.user.id, 'ADD', `Bot adicionado via token: ${name}`);
            logUserAction(interaction.user.id, botId, 'ADD_BOT', `Adicionou bot ${name} (${code})`);

            const embed = new EmbedBuilder()
                .setColor(config.bot.color)
                .setTitle(`${config.emojis.success} Bot Adicionado!`)
                .setDescription(
                    `**Nome:** \`${name}\`\n` +
                    `**Código:** \`${code}\`\n` +
                    `**ID:** \`${botId}\`\n` +
                    `**Status:** \`offline\`\n\n` +
                    `Use o código \`${code}\` para gerenciar este bot.`
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('back_to_panel').setLabel('Voltar ao Painel').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary)
            );

            await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        }

        else if (customId === 'add_via_file') {
            const modal = new ModalBuilder()
                .setCustomId('modal_add_file')
                .setTitle('Adicionar Bot via Arquivo ZIP');

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('bot_token')
                        .setLabel('Token do Bot')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('MTA0...')
                        .setMinLength(50)
                        .setMaxLength(100)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('bot_name')
                        .setLabel('Nome do Bot')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('Meu Bot')
                        .setMinLength(1)
                        .setMaxLength(32)
                        .setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('bot_desc')
                        .setLabel('Descrição (opcional)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setMaxLength(200)
                        .setRequired(false)
                )
            );

            await interaction.showModal(modal);
        }

        else if (customId === 'add_via_github') {
            const modal = new ModalBuilder()
                .setCustomId('modal_add_github')
                .setTitle('Adicionar Bot via GitHub');

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('repo_url').setLabel('URL do repositório').setStyle(TextInputStyle.Short)
                        .setPlaceholder('https://github.com/usuario/repositorio').setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('branch').setLabel('Branch').setStyle(TextInputStyle.Short)
                        .setValue('main').setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('bot_token').setLabel('Token do Bot').setStyle(TextInputStyle.Short)
                        .setPlaceholder('MTA0...').setMinLength(50).setMaxLength(100).setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('bot_name').setLabel('Nome do Bot').setStyle(TextInputStyle.Short)
                        .setMinLength(1).setMaxLength(32).setRequired(true)
                ),
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('bot_desc').setLabel('Descrição (opcional)').setStyle(TextInputStyle.Paragraph)
                        .setMaxLength(200).setRequired(false)
                )
            );

            await interaction.showModal(modal);
        }

        else if (customId === 'modal_add_github') {
            const repoUrl = interaction.fields.getTextInputValue('repo_url').trim();
            const branch = interaction.fields.getTextInputValue('branch').trim();
            const token = interaction.fields.getTextInputValue('bot_token').trim();
            const name = interaction.fields.getTextInputValue('bot_name').trim();
            const description = interaction.fields.getTextInputValue('bot_desc') || '';

            if (!TOKEN_REGEX.test(token)) {
                return interaction.reply({ content: `${config.emojis.error} Token inválido.`, ephemeral: true });
            }
            if (!canAddBot(interaction.user.id)) {
                const plan = getUserPlanInfo(interaction.user.id);
                return interaction.reply({ content: `${config.emojis.error} Você atingiu o limite do seu plano **${plan.name}** (${plan.maxBots} bot).`, ephemeral: true });
            }
            const deployLimitGh = checkRateLimit(`deploy:${interaction.user.id}`, 5, 60 * 60 * 1000);
            if (!deployLimitGh.allowed) {
                return interaction.reply({ content: `${config.emojis.error} Limite de criação de bots atingido. Tente novamente em ${formatRetryAfter(deployLimitGh.retryAfterMs)}.`, ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            const { cloneRepo } = require('../managers/githubManager');
            const botId = generateId();
            const code = generateBotCode('BOT');
            const folderPath = path.resolve(config.system.botsFolder, botId);

            try {
                const { language, mainFile, detectedByAI } = await cloneRepo(repoUrl, branch, folderPath);

                const { getBestNode } = require('../managers/nodeManager');
                const nodeId = getBestNode();

                run(
                    `INSERT INTO bots (id, code, name, description, token, language, main_file, creator_id, folder_path, status, node_id, github_repo, github_branch)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'offline', ?, ?, ?)`,
                    [botId, code, name, description, encrypt(token), language, mainFile, interaction.user.id, folderPath, nodeId, repoUrl, branch]
                );

                logAction(botId, interaction.user.id, 'ADD', `Bot adicionado via GitHub: ${repoUrl} (${branch})`);
                logUserAction(interaction.user.id, botId, 'ADD_BOT', `Adicionou bot ${name} (${code}) via GitHub`);

                const installPromise = installDependencies(botId, folderPath);

                const embed = new EmbedBuilder()
                    .setColor(config.bot.color)
                    .setTitle(`${config.emojis.success} Bot Adicionado via GitHub!`)
                    .setDescription(
                        `**Nome:** \`${name}\`\n**Código:** \`${code}\`\n**Repositório:** ${repoUrl}\n**Branch:** \`${branch}\`\n**Linguagem:** \`${language}\`${detectedByAI ? ' 🧠 *(detectada por IA)*' : ''}\n\n` +
                        `Use o código \`${code}\` para gerenciar este bot. O painel do bot agora tem opções de **Atualizar**, **Trocar Branch** e **Rollback**.`
                    );
                await interaction.editReply({ embeds: [embed] });

                installPromise.then(success => {
                    interaction.followUp({ content: success ? `${config.emojis.success} Dependências instaladas!` : `${config.emojis.warning} Falha ao instalar dependências.`, ephemeral: true }).catch(() => {});
                }).catch(() => {});
            } catch (err) {
                await interaction.editReply({ content: `${config.emojis.error} ${err.message}` });
            }
        }

        else if (customId === 'modal_add_file') {
            const token = interaction.fields.getTextInputValue('bot_token').trim();
            const name = interaction.fields.getTextInputValue('bot_name').trim();
            const description = interaction.fields.getTextInputValue('bot_desc')?.trim() || '';

            if (!TOKEN_REGEX.test(token)) {
                return interaction.reply({ content: `${config.emojis.error} Token inválido! Verifique o formato.`, ephemeral: true });
            }

            if (!canAddBot(interaction.user.id)) {
                const plan = getUserPlanInfo(interaction.user.id);
                return interaction.reply({ 
                    content: `${config.emojis.error} Você atingiu o limite do seu plano **${plan.name}** (${plan.maxBots} bot). Faça upgrade para adicionar mais!`, 
                    ephemeral: true 
                });
            }

            // Mesma cota de deploy do fluxo por token — upload de ZIP também é
            // I/O (download + extração) e não deveria ter limite separado, senão
            // dava pra contornar o limite alternando entre os dois métodos.
            const deployLimitFile = checkRateLimit(`deploy:${interaction.user.id}`, 5, 60 * 60 * 1000);
            if (!deployLimitFile.allowed) {
                return interaction.reply({ content: `${config.emojis.error} Limite de criação de bots atingido. Tente novamente em ${formatRetryAfter(deployLimitFile.retryAfterMs)}.`, ephemeral: true });
            }

            // CORREÇÃO: deferReply antes de operações lentas (download + extração)
            await interaction.deferReply({ ephemeral: true });

            await interaction.editReply({
                content: `${config.emojis.warning} **Envie agora um arquivo ZIP** neste canal contendo seu bot.\n` +
                    `Deve conter \`index.js\`/\`main.js\` (JavaScript) ou \`main.py\`/\`bot.py\` (Python) na raiz.\n` +
                    `Máximo: ${config.security.maxFileSizeMB}MB. Você tem 5 minutos.\n` +
                    `🔒 Assim que o arquivo chegar, a hospedagem começa em segundos e a mensagem com o anexo é apagada automaticamente do canal — ninguém mais vê ou baixa seu ZIP.`,
            });

            let collected;
            try {
                collected = await interaction.channel.awaitMessages({
                    // CORREÇÃO: filtra pelo autor correto para evitar que outro usuário envie o ZIP
                    filter: (m) => m.author.id === interaction.user.id && m.attachments.size > 0,
                    max: 1,
                    time: 300000,
                    errors: ['time'],
                });
            } catch {
                return interaction.editReply({ content: `${config.emojis.error} Tempo esgotado. Nenhum arquivo recebido.` });
            }

            const message = collected.first();
            const attachment = message.attachments.first();

            if (!attachment || !attachment.name.toLowerCase().endsWith('.zip')) {
                await message.delete().catch(() => {});
                return interaction.editReply({ content: `${config.emojis.error} O arquivo enviado precisa ser um \`.zip\`.` });
            }

            // CORREÇÃO CRÍTICA (bug real reportado em produção — "Falha ao baixar
            // o anexo do Discord"): apagar a mensagem ANTES do fetch invalidava o
            // download quase sempre. Agora só apagamos DEPOIS que o download já
            // terminou (via callback onDownloaded dentro de deployBotFromZip) —
            // a mensagem continua saindo do ar em segundos, só que sem quebrar o
            // próprio processo que precisa ler o arquivo primeiro.
            const result = await deployBotFromZip({
                userId: interaction.user.id, name, token, description, attachment,
                onDownloaded: () => message.delete().catch(() => {}),
            });

            if (!result.success) {
                return interaction.editReply({ content: `${config.emojis.error} Erro ao processar o ZIP: ${result.error}` });
            }

            const embed = new EmbedBuilder()
                .setColor(config.bot.color)
                .setTitle(`${config.emojis.success} Bot Adicionado!`)
                .setDescription(
                    `**Nome:** \`${result.name}\`\n` +
                    `**Código:** \`${result.code}\`\n` +
                    `**Linguagem:** \`${result.language}\`${result.detectedByAI ? ` 🧠 *(detectada por IA${result.detectedFramework ? ` — framework: ${result.detectedFramework}` : ''})*` : ''}\n` +
                    `**Arquivo principal:** \`${result.mainFile}\`\n` +
                    `**Status:** \`offline\`\n\n` +
                    `Use o código \`${result.code}\` para gerenciar este bot.`
                );

            await interaction.editReply({ content: null, embeds: [embed] });

            result.installPromise.then((success) => {
                if (success) {
                    interaction.followUp({ content: `${config.emojis.success} Dependências do bot **${result.name}** instaladas com sucesso!`, ephemeral: true }).catch(() => {});
                } else {
                    interaction.followUp({ content: `${config.emojis.warning} Falha ao instalar dependências do bot **${result.name}**. Verifique os logs no console.`, ephemeral: true }).catch(() => {});
                }
            }).catch(() => {});
        }

        // ======================================================================
        // START BOTS
        // ======================================================================

        else if (customId === 'start_bots') {
            const totalBots = get('SELECT COUNT(*) as count FROM bots').count;
            const onlineBots = get("SELECT COUNT(*) as count FROM bots WHERE status = 'online'").count;
            const stats = await getSystemStats();

            const embed = new EmbedBuilder()
                .setColor(config.bot.color)
                .setTitle(`${config.emojis.start} Start Bots`)
                .setDescription(
                    `**Quantidade de bots:** \`${totalBots}\`\n` +
                    `**Bots online:** \`${onlineBots}\`\n` +
                    `**Bots offline:** \`${totalBots - onlineBots}\`\n\n` +
                    `**${config.emojis.cpu} Uso de CPU:** \`${stats.cpu}%\`\n` +
                    `**${config.emojis.ram} Uso de RAM:** \`${stats.ramUsed} / ${stats.ramTotal}\`\n`
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('back_to_panel').setLabel('Voltar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('bot_start_input').setLabel('Bot Start').setEmoji(config.emojis.start).setStyle(ButtonStyle.Success)
            );

            await interaction.update({ embeds: [embed], components: [row] });
        }

        else if (customId === 'bot_start_input') {
            const modal = new ModalBuilder()
                .setCustomId('modal_bot_start')
                .setTitle('Iniciar Bot');

            modal.addComponents(
                new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('bot_code')
                        .setLabel('Código do Bot')
                        .setStyle(TextInputStyle.Short)
                        .setPlaceholder('BOT-XXXXXX')
                        .setMinLength(3)
                        .setMaxLength(20)
                        .setRequired(true)
                )
            );

            await interaction.showModal(modal);
        }

        else if (customId === 'modal_bot_start') {
            const code = interaction.fields.getTextInputValue('bot_code').trim().toUpperCase();
            const bot = get('SELECT * FROM bots WHERE code = ?', [code]);

            if (!bot) {
                return interaction.reply({ content: `${config.emojis.error} Bot com código \`${code}\` não encontrado.`, ephemeral: true });
            }

            if (!canManageBot(interaction.user.id, bot, 'start') && !hasPermission(interaction.user.id, 'moderator')) {
                return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para iniciar este bot.`, ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: false });

            try {
                await startBot(bot.id);
                logAction(bot.id, interaction.user.id, 'START', `Bot iniciado: ${bot.name}`);
                logUserAction(interaction.user.id, bot.id, 'START_BOT', `Iniciou bot ${bot.name}`);

                const publicEmbed = new EmbedBuilder()
                    .setColor(config.bot.color)
                    .setTitle(`${config.emojis.powerOn} ${bot.name}`)
                    .setDescription(
                        `**Status:** \`online\`\n` +
                        `**Código:** \`${bot.code}\`\n` +
                        `**Linguagem:** \`${bot.language}\`\n` +
                        `**Criador:** <@${bot.creator_id}>\n` +
                        `**Iniciado em:** \`${formatDate(new Date())}\``
                    );

                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`pub_start_${bot.id}`).setLabel('Ligar').setEmoji(config.emojis.powerOn).setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`pub_stop_${bot.id}`).setLabel('Desligar').setEmoji(config.emojis.powerOff).setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`pub_restart_${bot.id}`).setLabel('Reiniciar').setEmoji(config.emojis.restart).setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`pub_logs_${bot.id}`).setLabel('Logs').setEmoji(config.emojis.logs).setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`pub_stats_${bot.id}`).setLabel('Estatísticas').setEmoji(config.emojis.stats).setStyle(ButtonStyle.Secondary)
                );

                await interaction.editReply({ embeds: [publicEmbed], components: [row] });
            } catch (err) {
                await interaction.editReply({ content: `${config.emojis.error} Erro ao iniciar bot: ${err.message}` });
            }
        }

        // ======================================================================
        // BOTÕES PÚBLICOS DO BOT
        // ======================================================================

        else if (customId.startsWith('pub_start_')) {
            const botId = customId.replace('pub_start_', '');
            const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
            if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });

            const { hasBotPermission } = require('../managers/collaboratorManager');
            if (!canManageBot(interaction.user.id, bot) || !hasBotPermission(interaction.user.id, botId, 'start')) {
                return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para ligar este bot.`, ephemeral: true });
            }

            if (bot.status === 'online') return interaction.reply({ content: `${config.emojis.warning} Bot já está online.`, ephemeral: true });

            await interaction.deferReply({ ephemeral: true });
            try {
                await startBot(botId);
                logAction(botId, interaction.user.id, 'START', 'Bot iniciado via painel público');
                await interaction.editReply({ content: `${config.emojis.success} Bot **${bot.name}** iniciado!` });
            } catch (err) {
                await interaction.editReply({ content: `${config.emojis.error} ${err.message}` });
            }
        }

        else if (customId.startsWith('pub_stop_')) {
            const botId = customId.replace('pub_stop_', '');
            const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
            if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });

            const { hasBotPermission } = require('../managers/collaboratorManager');
            if (!canManageBot(interaction.user.id, bot) || !hasBotPermission(interaction.user.id, botId, 'stop')) {
                return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para desligar este bot.`, ephemeral: true });
            }

            stopBot(botId);
            logAction(botId, interaction.user.id, 'STOP', 'Bot desligado via painel público');
            await interaction.reply({ content: `${config.emojis.success} Bot **${bot.name}** desligado!`, ephemeral: true });
        }

        else if (customId.startsWith('pub_restart_')) {
            const botId = customId.replace('pub_restart_', '');
            const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
            if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });

            if (!canManageBot(interaction.user.id, bot, 'start')) {
                return interaction.reply({ content: `${config.emojis.error} Apenas o dono ou um moderador pode reiniciar este bot.`, ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });
            try {
                await restartBot(botId);
                logAction(botId, interaction.user.id, 'RESTART', 'Bot reiniciado via painel público');
                await interaction.editReply({ content: `${config.emojis.success} Bot **${bot.name}** reiniciado!` });
            } catch (err) {
                await interaction.editReply({ content: `${config.emojis.error} ${err.message}` });
            }
        }

        else if (customId.startsWith('pub_logs_')) {
            const botId = customId.replace('pub_logs_', '');
            const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
            if (!bot) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });
            // CORREÇÃO (IDOR): diferente de stats (uptime/ping/guilds — ok ser público),
            // os logs brutos podem conter erros com caminhos internos, IDs, e outros
            // detalhes que não deveriam ser visíveis a qualquer membro do canal.
            if (!canManageBot(interaction.user.id, bot, 'logs')) {
                logSecurityEvent(interaction.user.id, 'ACCESS_DENIED', `Tentou ver logs do bot ${botId} sem permissão`);
                return interaction.reply({ content: `${config.emojis.error} Você não tem permissão para ver os logs deste bot.`, ephemeral: true });
            }

            await interaction.deferReply({ ephemeral: true });

            // CORREÇÃO (crash): getRecentLogs(botId) retorna uma STRING já formatada,
            // não um array de objetos {type,time,text} — o .map() abaixo quebrava com
            // TypeError toda vez que este botão era clicado. analyzeBotLogs(botId, texto)
            // também precisa dos DOIS argumentos (e precisa de 'await', é assíncrona).
            const logText = getRecentLogs(botId);
            let logContent = logText && logText.length > 0 ? logText : 'Nenhum log registrado ainda.';

            if (logContent.length > 3000) logContent = '... (truncado)\n' + logContent.substring(logContent.length - 3000);

            const diagnosis = await analyzeBotLogs(botId, logText);
            const health = getHealthDisplay(bot.health_status);

            const embed = new EmbedBuilder()
                .setColor(bot.status === 'online' ? '#00FF00' : '#FF0000')
                .setTitle(`${config.emojis.logs} Console: ${bot.name}`)
                .setDescription(`**Saúde:** ${health.emoji} ${health.text}\n\n\`\`\`md\n${logContent}\n\`\`\``)
                .setTimestamp();

            if (diagnosis) {
                embed.addFields({
                    name: `🔍 Diagnóstico IA`,
                    value: String(diagnosis).substring(0, 1024)
                });
            }

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`pub_logs_${botId}`).setLabel('Atualizar').setEmoji(config.emojis.restart).setStyle(ButtonStyle.Secondary)
            );

            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({ embeds: [embed], components: [row] });
            } else {
                await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
            }
        }

        else if (customId.startsWith('pub_stats_')) {
            const botId = customId.replace('pub_stats_', '');
            const stats = await getBotStats(botId);
            if (!stats) return interaction.reply({ content: 'Bot não encontrado.', ephemeral: true });

            const embed = new EmbedBuilder()
                .setColor(config.bot.color)
                .setTitle(`${config.emojis.stats} Estatísticas — ${stats.name}`)
                .setDescription(
                    `**Status:** \`${stats.status}\`\n` +
                    `**CPU:** \`${stats.cpu_usage}%\`\n` +
                    `**RAM:** \`${stats.ram_usage}MB\`\n` +
                    `**Ping:** \`${stats.ping}ms\`\n` +
                    `**Guilds:** \`${stats.guilds}\`\n` +
                    `**Usuários:** \`${stats.users}\`\n` +
                    `**Canais:** \`${stats.channels}\`\n` +
                    `**Cargos:** \`${stats.roles}\`\n` +
                    `**Comandos:** \`${stats.commands}\`\n` +
                    `**Versão:** \`${stats.version || 'N/A'}\`\n` +
                    `**Biblioteca:** \`${stats.library || 'N/A'}\`\n` +
                    `**Linguagem:** \`${stats.language}\`\n` +
                    `**Sistema:** \`${stats.os || 'N/A'}\`\n` +
                    `**Tempo Online:** \`${stats.uptimeFormatted}\`\n` +
                    `**Última Reinicialização:** \`${formatDate(stats.last_start)}\`\n` +
                    `**ID:** \`${stats.id}\`\n` +
                    `**Criador:** <@${stats.creator_id}>`
                );

            await interaction.reply({ embeds: [embed], ephemeral: true });
        }

        // ======================================================================
        // MEUS BOTS
        // ======================================================================

        // ======================================================================
        // SISTEMA DE VENDAS - CARRINHO E PLANOS
        // ======================================================================

        // ── sales / affiliate / admin: movidos para src/handlers/domains/ ──
        // (tratados pelo routeDomain no início do handler)

        // ── bots / files: movidos para src/handlers/domains/ ──

        else if (customId === 'settings') {
            const embed = new EmbedBuilder()
                .setColor(config.bot.color)
                .setTitle(`${config.emojis.settings} Configurações`)
                .setDescription(
                    `**Idioma:** \`Português (BR)\`\n` +
                    `**Limite de bots:** \`${config.security.maxBotsPerUser}\`\n` +
                    `**CPU máxima por bot:** \`${config.security.maxCpuPerBot}%\`\n` +
                    `**RAM máxima por bot:** \`${config.security.maxRamPerBot}MB\`\n` +
                    `**Auto Restart:** \`${config.system.autoRestart ? 'Ativado' : 'Desativado'}\`\n` +
                    `**Auto Backup:** \`${config.backup.autoBackup ? 'Ativado' : 'Desativado'}\`\n` +
                    `**Notificações:** \`${config.notifications.webhookUrl ? 'Ativadas' : 'Desativadas'}\`\n` +
                    `**Versão:** \`v${config.bot.version}\`\n`
                );

            // CORREÇÃO (feature inacessível): o Programa de Afiliados ('affiliate_panel')
            // já existia totalmente implementado (código, saldo, resgate, indicação),
            // mas nenhum botão da UI levava até ele.
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('affiliate_panel').setLabel('Programa de Afiliados').setEmoji('🤝').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('back_to_panel').setLabel('Voltar').setEmoji(config.emojis.back).setStyle(ButtonStyle.Secondary)
            );

            await interaction.update({ embeds: [embed], components: [row] });
        }

        // ======================================================================
        // CONFIG BOT LIST
        // ======================================================================

        // config_bot_* movido para domains/bots.js

    } catch (err) {
        console.error('❌ Erro no handler de interação:', err);
        // Remove cooldown em caso de erro para não bloquear o usuário
        cooldowns.delete(interaction.user.id);
        const errMsg = { content: `${config.emojis.error} Ocorreu um erro: ${err.message}`, ephemeral: true };
        try {
            if (interaction.deferred) {
                await interaction.editReply(errMsg);
            } else if (!interaction.replied) {
                await interaction.reply(errMsg);
            } else {
                await interaction.followUp(errMsg);
            }
        } catch {
            // Ignora erros ao tentar responder
        }
    }
}

// ── PAINEL INDIVIDUAL DO BOT ───────────────────────────────────────────────────

/**
 * Mostra o painel de controle de um bot específico
 */
/**
 * Codifica/decodifica um caminho relativo pra caber num customId/value do
 * Discord (limite de ~100 caracteres, e não pode ter certos caracteres).
 * base64url é compacto e seguro pra isso.
 */
// showBotPanel / showConfigPanel / showFileBrowser → panelHelpers.js

module.exports = { handleInteraction };
