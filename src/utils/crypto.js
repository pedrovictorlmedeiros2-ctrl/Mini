/**
 * SISTEMA DE CRIPTOGRAFIA
 * Criptografa tokens e dados sensiveis usando AES-256-GCM via crypto nativo.
 * Formato: v2:<salt>:<iv>:<authTag>:<ciphertext>
 */
require('dotenv').config({ override: true });

const crypto = require('crypto');
const config = require('../../config');

const KEY = config.security.encryptionKey;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

if (!KEY || KEY.length < 16) {
    throw new Error(
        'ENCRYPTION_KEY nao definida (ou curta demais) no .env! ' +
        'Defina uma chave forte com pelo menos 16 caracteres antes de iniciar o bot.'
    );
}

function deriveKey(salt) {
    return crypto.scryptSync(KEY, salt, KEY_LEN);
}

function encrypt(text) {
    if (!text) return null;

    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const key = deriveKey(salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const payload = Buffer.concat([salt, iv, authTag, ciphertext]);
    return `v2:${payload.toString('base64')}`;
}

function decrypt(encrypted) {
    if (!encrypted) return null;

    try {
        if (encrypted.startsWith('v2:')) {
            const payload = Buffer.from(encrypted.slice(3), 'base64');
            const salt = payload.subarray(0, SALT_LEN);
            const iv = payload.subarray(SALT_LEN, SALT_LEN + IV_LEN);
            const authTag = payload.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
            const ciphertext = payload.subarray(SALT_LEN + IV_LEN + TAG_LEN);
            const key = deriveKey(salt);
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            return plaintext.toString('utf8');
        }

        // Compatibilidade com valores antigos do crypto-js.
        const CryptoJS = require('crypto-js');
        const bytes = CryptoJS.AES.decrypt(encrypted, KEY);
        return bytes.toString(CryptoJS.enc.Utf8);
    } catch {
        return null;
    }
}

function maskToken(token) {
    if (!token || token.length < 15) return '***';
    return token.slice(0, 5) + '..........................' + token.slice(-5);
}

module.exports = { encrypt, decrypt, maskToken };
