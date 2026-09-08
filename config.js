/**
 * CONFIGURAÇÃO CENTRAL DO SISTEMA
 * Todas as configurações do bot de hospedagem
 * 
 * Nota: dotenv.config() é chamado no index.js (entry point).
 * Este arquivo apenas exporta as configurações.
 */

// Lê a versão do package.json dinamicamente
const pkg = require('./package.json');

module.exports = {
    // ─── BOT PRINCIPAL ───
    bot: {
        token: process.env.BOT_TOKEN,
        clientId: process.env.CLIENT_ID,
        guildId: process.env.GUILD_ID || null,
        ownerId: process.env.OWNER_ID,
        version: pkg.version || '7.0.0',
        color: '#5865F2',           // Discord Blurple - cor padrão dos embeds
        ephemeral: true,            // Comandos são efêmeros por padrão
    },

    // ─── SEGURANÇA + PROTEÇÃO DO HOST ───
    security: {
        encryptionKey: process.env.ENCRYPTION_KEY,
        // Limites padrão por usuário/bot (plano free / default)
        maxBotsPerUser: parseInt(process.env.MAX_BOTS_PER_USER) || 3,
        maxCpuPerBot: parseInt(process.env.MAX_CPU_PER_BOT) || 30,      // %
        maxRamPerBot: parseInt(process.env.MAX_RAM_PER_BOT) || 256,     // MB

        // TETO ABSOLUTO por bot (mesmo se o plano for maior) — protege o PC
        hostMaxRamPerBot: parseInt(process.env.HOST_MAX_RAM_PER_BOT) || 512,  // MB
        hostMaxCpuPerBot: parseInt(process.env.HOST_MAX_CPU_PER_BOT) || 50,   // %

        // % máxima da RAM TOTAL do PC que todos os bots juntos podem usar
        // Ex: PC com 8GB → 60% = ~4.8GB pro conjunto de bots
        hostMaxRamPercent: parseInt(process.env.HOST_MAX_RAM_PERCENT) || 55,

        maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB) || 50,
        // Protege contra zip bomb: o limite acima (maxFileSizeMB) só vale para
        // o .zip comprimido — um arquivo pequeno pode se expandir para vários
        // GB depois de extraído. Estes dois limites cobrem o conteúdo real.
        maxUnzippedSizeMB: parseInt(process.env.MAX_UNZIPPED_SIZE_MB) || 300,
        maxZipEntries: parseInt(process.env.MAX_ZIP_ENTRIES) || 2000,
        antiSpamCooldown: 3000,
        maxUploadSizeMB: 100,

        // ─── KAMIKAZE MODE (resposta automática a incidentes) ───
        kamikaze: {
            enabled: process.env.KAMIKAZE_ENABLED !== 'false', // default ligado
            // Janela de correlação: sinais HIGH do mesmo bot dentro deste
            // intervalo podem se combinar pra escalar a CRITICAL (ver
            // SecurityEngine.js). Fora da janela, sinais são tratados como
            // eventos novos e independentes.
            correlationWindowMs: parseInt(process.env.KAMIKAZE_CORRELATION_WINDOW_MS) || 2 * 60 * 1000,
            // Quantas ocorrências do MESMO tipo de sinal, dentro da janela,
            // fazem um SUSPICIOUS virar HIGH.
            highThresholdCount: parseInt(process.env.KAMIKAZE_HIGH_THRESHOLD_COUNT) || 3,
            // Retenção da cópia em quarentena — só relevante pra uma futura
            // purga manual/automática (não construída nesta entrega).
            quarantineRetentionDays: parseInt(process.env.KAMIKAZE_QUARANTINE_RETENTION_DAYS) || 30,
        },

        // ─── SECURITY MONITOR + GROQ (analisador auxiliar, Fase 2) ───
        // O Groq NUNCA decide CRITICAL sozinho — só enriquece sinais que já
        // passam pelas regras determinísticas do SecurityEngine (ver
        // ThreatDecisionPolicy.js). Se ficar indisponível, o Kamikaze
        // determinístico continua funcionando exatamente igual.
        groqMonitor: {
            // Precisa de GROQ_API_KEY definida MESMO com isto true — sem a
            // chave, o monitor roda mas o GroqThreatAnalyzer nunca tenta
            // rede nenhuma (retorna indisponível na hora).
            enabled: process.env.GROQ_MONITOR_ENABLED !== 'false',
            pollIntervalMs: parseInt(process.env.GROQ_MONITOR_POLL_INTERVAL_MS) || 30000,
            requestTimeoutMs: parseInt(process.env.GROQ_MONITOR_TIMEOUT_MS) || 5000,
            // Retries ADICIONAIS além da primeira tentativa (1 = 2 tentativas no total).
            maxRetries: parseInt(process.env.GROQ_MONITOR_MAX_RETRIES) || 1,
            rateLimitPerMinute: parseInt(process.env.GROQ_MONITOR_RATE_LIMIT_PER_MIN) || 20,
            circuitBreakerFailureThreshold: parseInt(process.env.GROQ_MONITOR_CIRCUIT_THRESHOLD) || 5,
            circuitBreakerCooldownMs: parseInt(process.env.GROQ_MONITOR_CIRCUIT_COOLDOWN_MS) || 2 * 60 * 1000,
            // Confiança mínima da resposta do Groq pra sequer alimentar o
            // SecurityEngine como um sinal SUSPICIOUS/HIGH — abaixo disso,
            // fica só registrado no audit_log, sem nenhuma ação.
            minConfidenceToForwardSignal: parseFloat(process.env.GROQ_MONITOR_MIN_CONFIDENCE) || 0.6,
        },
    },

    // ─── RECURSOS DO SISTEMA ───
    system: {
        botsFolder: './bots',
        backupsFolder: './backups',
        logsFolder: './logs',
        receiptsFolder: './receipts',
        // Pasta dedicada e separada de ./bots e ./backups — nunca fica
        // dentro de nenhuma das duas, pra nunca ser varrida por engano por
        // uma limpeza/listagem que assume que só bots ativos moram ali.
        quarantineFolder: './quarantine',
        bannerPath: './banner.png',
        salesBannerPath: './vendas-banner.png',
        autoRestart: true,
        autoRestartMaxAttempts: 5,
        autoRestartDelay: 5000,     // ms
        queueInterval: 2000,        // ms entre inícios na fila
    },

    // ─── BACKUP ───
    backup: {
        autoBackup: true,
        dailyBackup: true,
        weeklyBackup: true,
        monthlyBackup: true,
        keepBackups: 30,            // Quantidade de backups a manter
    },

    // ─── MONITORAMENTO ───
    monitoring: {
        interval: 5000,             // Intervalo de coleta (ms)
        cpuThreshold: 80,           // Alerta CPU %
        ramThreshold: 80,           // Alerta RAM %
        diskThreshold: 90,          // Alerta Disco %
    },

    // ─── NOTIFICAÇÕES ───
    notifications: {
        webhookUrl: process.env.LOG_WEBHOOK_URL || null,
        logChannelId: null,
        notifyOnStart: true,
        notifyOnStop: true,
        notifyOnCrash: true,
        notifyOnHighResource: true,
        // Canais de Status Dinâmicos (Inspirado no Storm)
        statusChannels: {
            members: process.env.STATUS_CHANNEL_MEMBERS || null,
            ping: process.env.STATUS_CHANNEL_PING || null,
            bots: process.env.STATUS_CHANNEL_BOTS || null,
            uptime: process.env.STATUS_CHANNEL_UPTIME || null,
        }
    },

    // ─── PERMISSÕES ───
    permissions: {
        admin: ['admin', 'administrator'],
        moderator: ['mod', 'moderator', 'moderador'],
        client: ['client', 'cliente'],
        viewer: ['viewer', 'visualizador'],
    },

    // ─── EMOJIS PADRÃO ───
    emojis: {
        add: '➕',
        start: '🚀',
        myBots: '📂',
        settings: '⚙️',
        back: '⬅️',
        addBot: '➕',
        configBot: '⚙',
        token: '🔑',
        file: '📦',
        powerOn: '🟢',
        powerOff: '🔴',
        restart: '🔄',
        logs: '📜',
        stats: '📊',
        files: '📂',
        variables: '🌐',
        backup: '💾',
        restore: '⬇️',
        delete: '🗑',
        cpu: '💻',
        ram: '🧠',
        disk: '💿',
        network: '🌐',
        ping: '📡',
        uptime: '⏱',
        warning: '⚠️',
        success: '✅',
        error: '❌',
        loading: '⏳',
        search: '🔍',
        favorite: '⭐',
        tag: '🏷',
        category: '📁',
        terminal: '💻',
        upload: '📤',
        download: '📥',
        lock: '🔒',
        unlock: '🔓',
    },
};
