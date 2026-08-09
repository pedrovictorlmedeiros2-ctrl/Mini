/**
 * GERADOR DE CÓDIGOS ÚNICOS PARA BOTS
 * Usa crypto.randomBytes para evitar colisões e previsibilidade
 */
const crypto = require('crypto');

/**
 * Gera um código único para o bot no formato PREFIX-XXXXXX
 * Usa entropia criptográfica para evitar colisões
 */
function generateBotCode(prefix = 'BOT') {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[bytes[i] % chars.length];
    }
    return `${prefix}-${code}`;
}

/**
 * Gera um ID único baseado em timestamp + entropia criptográfica
 * Formato: timestamp36 + random16hex → colisão praticamente impossível
 */
function generateId() {
    const ts = Date.now().toString(36);
    const rand = crypto.randomBytes(8).toString('hex');
    return `${ts}${rand}`;
}

module.exports = { generateBotCode, generateId };
