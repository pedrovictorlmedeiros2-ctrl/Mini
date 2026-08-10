/**
 * SESSÃO DO PAINEL DO CLIENTE — cookie assinado (HMAC-SHA256), sem estado no
 * servidor (nenhuma tabela de sessões pra manter/limpar).
 *
 * Por que não JWT de uma lib? O projeto já implementa suas próprias
 * primitivas de segurança à mão (crypto.js, fileCrypto.js, panelAuth.js,
 * security_wrapper.js) em vez de importar pacotes pra isso — mesmo espírito
 * aqui: um HMAC simples cobre exatamente o que precisamos (usuário +
 * expiração, à prova de adulteração) sem puxar uma dependência nova.
 *
 * Formato do cookie: base64url(payloadJSON) + "." + hmacHex(payloadJSON)
 * payload = { sub: discordUserId, iat: <epoch ms>, exp: <epoch ms> }
 */
const crypto = require('crypto');

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

function getSecret() {
    const secret = process.env.PANEL_SESSION_SECRET;
    if (!secret || secret.length < 16) {
        throw new Error('PANEL_SESSION_SECRET não configurado ou muito curto (mínimo 16 caracteres).');
    }
    return secret;
}

function base64url(input) {
    return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(input) {
    const padded = input.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    return Buffer.from(padded + pad, 'base64').toString('utf8');
}

function sign(payloadJson) {
    return crypto.createHmac('sha256', getSecret()).update(payloadJson).digest('hex');
}

/**
 * Cria o valor do cookie de sessão para um usuário do Discord.
 * @param {string} discordUserId
 * @returns {string} valor pronto pra ir no cookie
 */
function createSessionToken(discordUserId) {
    if (!discordUserId || typeof discordUserId !== 'string') {
        throw new Error('discordUserId inválido.');
    }
    const now = Date.now();
    const payload = { sub: discordUserId, iat: now, exp: now + SESSION_TTL_MS };
    const payloadJson = JSON.stringify(payload);
    const encoded = base64url(payloadJson);
    const signature = sign(payloadJson);
    return `${encoded}.${signature}`;
}

/**
 * Verifica e decodifica um token de sessão.
 * @param {string} token
 * @returns {{ sub: string, iat: number, exp: number } | null} payload válido, ou null se inválido/expirado/adulterado
 */
function verifySessionToken(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const dotIndex = token.lastIndexOf('.');
    const encoded = token.slice(0, dotIndex);
    const providedSig = token.slice(dotIndex + 1);
    if (!encoded || !providedSig) return null;

    let payloadJson;
    try {
        payloadJson = fromBase64url(encoded);
    } catch {
        return null;
    }

    let expectedSig;
    try {
        expectedSig = sign(payloadJson);
    } catch {
        return null; // PANEL_SESSION_SECRET não configurado
    }

    const a = Buffer.from(providedSig, 'utf8');
    const b = Buffer.from(expectedSig, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    let payload;
    try {
        payload = JSON.parse(payloadJson);
    } catch {
        return null;
    }
    if (!payload || typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (Date.now() > payload.exp) return null; // expirado

    return payload;
}

const COOKIE_NAME = 'atlantic_session';

module.exports = {
    COOKIE_NAME,
    SESSION_TTL_MS,
    createSessionToken,
    verifySessionToken,
};
