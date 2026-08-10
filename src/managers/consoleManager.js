/**
 * GERENCIADOR DE CONSOLE (LIVE LOGS)
 * Mantém um buffer circular de logs em memória para visualização rápida
 * e persiste logs em arquivos para histórico longo.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { formatDate } = require('../utils/format');

const LOG_DIR = path.join(__dirname, '../../logs/bots');
const MAX_BUFFER_LINES = 50; // Quantas linhas manter na memória para o "Ver Console"
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024; // 5MB — acima disso, roda rotação

// Map para armazenar os logs recentes em memória: botId -> string[]
const logBuffers = new Map();

// NOVA FEATURE: emissor de eventos pra console ao vivo no painel web (SSE).
// Cada linha nova de log emite `line:<botId>` com o texto formatado — o
// painel web se inscreve só no evento do bot que está olhando, então isso
// não custa nada extra pra bots que ninguém está observando no momento.
// unref() pra não segurar o processo vivo sozinho, e um teto generoso de
// listeners (cada aba do painel aberta assina um) sem soar alarme de leak.
const consoleEvents = new EventEmitter();
consoleEvents.setMaxListeners(200);

/**
 * Roda o arquivo de log se ele passar do tamanho máximo: renomeia para .old
 * (sobrescrevendo a rotação anterior) e começa um arquivo novo. Sem isso, o
 * log de um bot que roda por meses cresce sem limite até estourar o disco.
 */
function rotateLogIfNeeded(logFile) {
    try {
        const stat = fs.statSync(logFile);
        if (stat.size > MAX_LOG_FILE_BYTES) {
            fs.renameSync(logFile, `${logFile}.old`);
        }
    } catch {
        // Arquivo ainda não existe — nada a rotacionar
    }
}

/**
 * Inicializa a estrutura de logs
 */
function initConsole() {
    if (!fs.existsSync(LOG_DIR)) {
        fs.mkdirSync(LOG_DIR, { recursive: true });
    }
}

/**
 * Adiciona uma linha ao log do bot (memória + arquivo)
 *
 * CORREÇÃO (robustez): esta função assumia que LOG_DIR sempre existe porque
 * initConsole() roda uma vez no boot do painel. Mas se a pasta sumir depois
 * (delete acidental, volume Docker remontado, etc.), fs.appendFileSync
 * lançava ENOENT dentro de um listener de stream ('data' do stdout do bot),
 * fora de qualquer try/catch do chamador — derrubando o processo principal
 * inteiro só porque UM bot hospedado imprimiu uma linha de log. Agora
 * recria a pasta na hora se necessário, e nunca deixa uma falha de log
 * derrubar o painel.
 */
function addLog(botId, data, type = 'stdout') {
    const lines = data.toString().split('\n').filter(line => line.trim().length > 0);
    const timestamp = formatDate(new Date());
    
    // 1. Persistir no arquivo
    const logFile = path.join(LOG_DIR, `${botId}.log`);
    const formattedLines = lines.map(line => `[${timestamp}] [${type.toUpperCase()}] ${line}`).join('\n') + '\n';

    try {
        rotateLogIfNeeded(logFile);
        fs.appendFileSync(logFile, formattedLines);
    } catch (err) {
        // Provável causa: LOG_DIR não existe (mais comum) ou outro problema de
        // disco. Tenta recriar a pasta e escrever de novo, uma única vez.
        try {
            fs.mkdirSync(LOG_DIR, { recursive: true });
            fs.appendFileSync(logFile, formattedLines);
        } catch (retryErr) {
            // Se mesmo assim falhar (disco cheio, permissão, etc.), registra no
            // console do painel mas NUNCA deixa isso derrubar o processo — o
            // buffer em memória abaixo continua funcionando normalmente.
            console.error(`⚠️ Falha ao persistir log do bot ${botId} em disco:`, retryErr.message);
        }
    }

    // 2. Atualizar buffer em memória
    if (!logBuffers.has(botId)) {
        logBuffers.set(botId, []);
    }
    
    const buffer = logBuffers.get(botId);
    lines.forEach(line => {
        const formatted = `\`[${timestamp.split(' ')[1]}]\` ${type === 'stderr' ? '🔴' : '⚪'} ${line}`;
        buffer.push(formatted);
        consoleEvents.emit(`line:${botId}`, { line, type, timestamp: Date.now() });
    });

    // Limitar tamanho do buffer
    while (buffer.length > MAX_BUFFER_LINES) {
        buffer.shift();
    }
}

/**
 * Obtém os logs recentes do bot
 */
function getRecentLogs(botId) {
    const buffer = logBuffers.get(botId) || [];
    if (buffer.length === 0) return 'Nenhum log registrado ainda.';
    return buffer.join('\n');
}

/**
 * Limpa o buffer de memória do bot
 */
function clearBuffer(botId) {
    logBuffers.set(botId, []);
}

/**
 * Retorna o caminho do arquivo de log em disco (usado para "Baixar Logs").
 * Retorna null se o arquivo ainda não existe (bot nunca gerou log).
 */
function getLogFilePath(botId) {
    const logFile = path.join(LOG_DIR, `${botId}.log`);
    return fs.existsSync(logFile) ? logFile : null;
}

/**
 * NOVA FEATURE: pesquisa nos logs recentes (buffer em memória) por um termo.
 * Case-insensitive. Retorna as linhas que contêm o termo, mais recentes primeiro.
 */
function searchLogs(botId, term, limit = 30) {
    const buffer = logBuffers.get(botId) || [];
    const needle = term.toLowerCase();
    return buffer
        .filter(line => line.toLowerCase().includes(needle))
        .slice(-limit)
        .reverse();
}

module.exports = {
    initConsole,
    addLog,
    getRecentLogs,
    clearBuffer,
    getLogFilePath,
    searchLogs,
    consoleEvents,
};
