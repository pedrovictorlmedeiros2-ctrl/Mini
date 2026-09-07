/**
 * ENTRY POINT — BOT DE HOSPEDAGEM v8.0 ENTERPRISE (MULTI-PLATFORM)
 * Inicializa o cliente Discord, banco de dados, handlers e proxy reverso
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const major = parseInt(process.versions.node.split('.')[0], 10);
// CORREÇÃO: só checava o teto (> 24), nunca o piso. O banco de dados usa o
// módulo nativo `node:sqlite` (ver src/database/sqliteCompat.js), que só
// existe a partir do Node 22 — em versões mais antigas (18, 20, comuns em
// imagens Docker/hosts desatualizados) o processo quebrava com um erro feio
// de "Cannot find module 'node:sqlite'" lá no meio do require(), em vez de
// mostrar esta mensagem clara logo no início.
if (major < 22) {
    console.error(`❌ Esta versão do Node.js (${process.version}) não é suportada. O banco de dados usa o módulo nativo 'node:sqlite', disponível só a partir do Node 22. Use Node 22 ou 24.`);
    process.exit(1);
}
if (major > 24) {
    console.error('❌ Esta versão do Node.js não é suportada pelo projeto. Use Node 22 ou 24.');
    process.exit(1);
}

const { isWindows, commandExists } = require('./src/utils/runtime');
const { logStartupDiagnostics } = require('./src/utils/diagnostics');
console.log(`[BOOT] Plataforma: ${process.platform} | Node: ${process.version}`);
if (isWindows()) {
    console.log(`[BOOT] Windows detected; using compatible command resolution.`);
}
if (!commandExists('git')) {
    console.warn('[BOOT] git não encontrado no PATH. Alguns fluxos de deploy e clone podem falhar.');
}
logStartupDiagnostics();

// ── VALIDAÇÃO DE VARIÁVEIS DE AMBIENTE ────────────────────────────────────────
const REQUIRED_ENV = ['BOT_TOKEN', 'CLIENT_ID', 'ENCRYPTION_KEY', 'OWNER_ID'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
    console.error(`❌ Variáveis de ambiente obrigatórias não definidas: ${missingEnv.join(', ')}`);
    console.error('   Copie o arquivo .env.example para .env e preencha os valores.');
    process.exit(1);
}

const placeholderish = (value) => !value || /^(placeholder_token|placeholder|change-me|change-me-please|seu_token_do_discord|seu_client_id|seu_id_discord|your_bot_token|your_client_id|your_owner_id|123456789012345678)$/i.test(value);
if (placeholderish(process.env.BOT_TOKEN)) {
    console.error('❌ BOT_TOKEN ainda está com valor de exemplo. Substitua pelo token real do Discord.');
    process.exit(1);
}
if (placeholderish(process.env.CLIENT_ID)) {
    console.error('❌ CLIENT_ID ainda está com valor de exemplo. Substitua pelo client ID real do Discord.');
    process.exit(1);
}
if (placeholderish(process.env.OWNER_ID)) {
    console.error('❌ OWNER_ID ainda está com valor de exemplo. Substitua pelo ID real do Discord.');
    process.exit(1);
}

if ((process.env.ENCRYPTION_KEY || '').length < 16) {
    console.error('❌ ENCRYPTION_KEY deve ter pelo menos 16 caracteres.');
    process.exit(1);
}

if (!process.env.OWNER_ID || !/^\d{17,20}$/.test(process.env.OWNER_ID)) {
    console.error('❌ OWNER_ID deve ser um ID válido do Discord (17-20 dígitos).');
    process.exit(1);
}

const { Client, GatewayIntentBits, Collection, REST, Routes } = require('discord.js');
const config = require('./config');
const { initDatabase } = require('./src/database/database');
const { handleInteraction } = require('./src/handlers/interactionHandler');
const { stopBot, getOnlineBots, activeProcesses, syncStatusOnStartup } = require('./src/managers/processManager');
const { startScheduler, stopScheduler } = require('./src/managers/schedulerManager');
const { initConsole } = require('./src/managers/consoleManager');
const { startMonitoring } = require('./src/managers/monitorManager');
const { startWebhookServer } = require('./src/managers/githubManager');
const { startProxyServer } = require('./src/managers/proxyManager');
const { startMaintenanceScheduler } = require('./src/managers/maintenanceManager');
const { collectSystemMetrics } = require('./src/managers/metricsManager');
const { recordAuditEvent } = require('./src/managers/auditManager');
const { startHealthEndpoint } = require('./src/managers/healthEndpoint');
const { startWorkerAgent, stopWorkerAgent } = require('./src/managers/workerAgent');
const { startFailoverScheduler, stopFailoverScheduler } = require('./src/managers/failoverManager');

// ── INICIALIZAÇÃO DO BANCO DE DADOS, CONSOLE E MONITORAMENTO ──────────────────
initDatabase();
// CORREÇÃO: precisa rodar DEPOIS de initDatabase() — ver comentário detalhado
// junto da função em processManager.js. Antes rodava automaticamente ao
// importar o módulo (linha acima), ou seja, antes da tabela `bots` existir.
syncStatusOnStartup();
initConsole();
startScheduler();
startMonitoring(); // Inicia monitoramento de recursos a cada 30s
startMaintenanceScheduler();
startFailoverScheduler();
setInterval(() => collectSystemMetrics(), 5 * 60 * 1000);
startHealthEndpoint(process.env.HEALTH_PORT || 3001);
// Multi-node worker agent (só sobe se NODE_ROLE=worker ou WORKER_PORT definido)
if (process.env.NODE_ROLE === 'worker' || process.env.WORKER_PORT) {
    startWorkerAgent();
}
startWebhookServer(process.env.WEBHOOK_PORT || 3000);
startProxyServer(process.env.PROXY_PORT || 80);

// ── CLIENTE DISCORD ───────────────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

client.commands = new Collection();

// ── CARREGAMENTO DE COMANDOS ──────────────────────────────────────────────────
const commandsPath = path.join(__dirname, 'src', 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    try {
        const commandModule = require(filePath);
        const commands = Array.isArray(commandModule) ? commandModule : [commandModule];
        
        for (const command of commands) {
            if ('data' in command && 'execute' in command) {
                client.commands.set(command.data.name, command);
            } else {
                console.warn(`⚠️ Um comando em ${file} não tem 'data' ou 'execute'.`);
            }
        }
    } catch (err) {
        console.error(`❌ Erro ao carregar comando ${file}:`, err.message);
    }
}

// ── REGISTRO DE COMANDOS SLASH ────────────────────────────────────────────────
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(config.bot.token);
    const commands = Array.from(client.commands.values()).map(cmd => cmd.data.toJSON());

    try {
        if (config.bot.guildId) {
            await rest.put(
                Routes.applicationGuildCommands(config.bot.clientId, config.bot.guildId),
                { body: commands }
            );
            console.log(`✅ ${commands.length} comando(s) registrado(s) no servidor de teste.`);
        } else {
            await rest.put(
                Routes.applicationCommands(config.bot.clientId),
                { body: commands }
            );
            console.log(`✅ ${commands.length} comando(s) registrado(s) globalmente.`);
        }
    } catch (error) {
        const message = error?.message || 'Erro desconhecido';
        if (message.includes('Missing Access') || error?.status === 403 || error?.code === 50001) {
            console.warn('⚠️ Comandos slash não foram registrados por falta de permissão da aplicação na guilda. O bot continua online.');
        } else {
            console.warn(`⚠️ Não foi possível registrar os comandos slash: ${message}`);
        }
    }
}

// ── EVENTO READY ──────────────────────────────────────────────────────────────
client.once('ready', async () => {
    console.log(`\n🤖 Bot logado como: ${client.user.tag}`);
    console.log(`📡 Servidores: ${client.guilds.cache.size}`);
    console.log(`🔧 Comandos carregados: ${client.commands.size}`);
    console.log(`🌐 Ping: ${client.ws.ping}ms\n`);

    // Disponibiliza o client para managers em background (auto-restart, crash
    // loop, watchdog) que precisam mandar DM sem ter uma interação disponível.
    const { setClient } = require('./src/utils/clientRef');
    setClient(client);
    recordAuditEvent({ userId: config.bot.ownerId, event: 'bot_ready', details: `Painel online em ${client.guilds.cache.size} servidor(es)`, severity: 'info' });

    await registerCommands();
});

// ── HANDLER DE INTERAÇÕES ─────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            const command = client.commands.get(interaction.commandName);
            if (!command) return;
            await command.execute(interaction);
        } else if (
            interaction.isButton() ||
            interaction.isModalSubmit() ||
            interaction.isStringSelectMenu()
        ) {
            await handleInteraction(interaction);
        }
    } catch (error) {
        console.error('❌ Erro na interação:', error);
        const reply = { content: '❌ Ocorreu um erro ao processar esta ação.', ephemeral: true };
        try {
            if (interaction.deferred) {
                await interaction.editReply(reply);
            } else if (!interaction.replied) {
                await interaction.reply(reply);
            } else {
                await interaction.followUp(reply);
            }
        } catch {
            // Ignora erros ao tentar responder
        }
    }
});

// ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────
/**
 * CORREÇÃO: antes chamava stopBot() (que só agenda um SIGTERM e depois um
 * SIGKILL 5s depois via setTimeout, mas RETORNA na hora) e em seguida já
 * fazia process.exit(0) IMEDIATAMENTE — matando o painel antes mesmo do
 * SIGTERM ter qualquer efeito. Resultado: os processos dos bots hospedados
 * viravam órfãos toda vez que o painel era reiniciado normalmente (ex: deploy,
 * `pm2 restart`), exatamente o cenário de "zumbi" que syncStatusOnStartup()
 * precisa detectar depois. Agora esperamos de verdade os processos saírem do
 * Map de processos ativos (ou um teto de 7s) antes de encerrar o processo principal.
 */
async function gracefulShutdown(signal) {
    console.log(`\n⚠️ Recebido ${signal}. Encerrando graciosamente...`);
    stopScheduler();
    try { stopWorkerAgent(); } catch { /* ignore */ }
    try { stopFailoverScheduler(); } catch { /* ignore */ }

    const onlineBots = getOnlineBots();
    if (onlineBots.length > 0) {
        console.log(`🔴 Parando ${onlineBots.length} bot(s) hospedado(s)...`);
        for (const botId of onlineBots) {
            try { stopBot(botId); } catch { /* Ignora */ }
        }

        // Espera até 7s pelos processos realmente saírem do Map de ativos
        // (stopBot dá até 5s de graça pro SIGTERM antes de forçar SIGKILL).
        const maxWaitMs = 7000;
        const pollIntervalMs = 250;
        const deadline = Date.now() + maxWaitMs;
        while (Date.now() < deadline) {
            const stillActive = onlineBots.some(id => activeProcesses.has(id));
            if (!stillActive) break;
            await new Promise(r => setTimeout(r, pollIntervalMs));
        }
        console.log('✅ Bots hospedados finalizados (ou tempo limite de espera atingido).');
    }

    client.destroy();
    console.log('👋 Bot encerrado com sucesso.');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ── TRATAMENTO DE ERROS GLOBAIS ───────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
    console.error('❌ Unhandled Rejection:', err);
});
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception (fatal):', err);
    // CORREÇÃO: manter o processo rodando após uma uncaughtException é
    // arriscado — o estado interno (conexão com o banco, handles de arquivo,
    // etc.) pode estar corrompido, e erros assim tendem a se repetir de forma
    // imprevisível. A prática recomendada é encerrar de forma controlada e
    // deixar o supervisor de processo (Shard Cloud, PM2, systemd, etc.) subir
    // uma instância nova e limpa — muito mais seguro do que seguir rodando
    // "no escuro". gracefulShutdown já garante que os bots hospedados sejam
    // parados corretamente antes do processo principal sair.
    gracefulShutdown('uncaughtException').catch(() => process.exit(1));
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
client.login(config.bot.token).catch(err => {
    console.error('❌ Falha ao fazer login no Discord:', err.message);
    process.exit(1);
});
