/**
 * CRIPTOGRAFIA DE ARQUIVOS (para backups)
 *
 * crypto.js (crypto-js/AES) já cuida de strings pequenas (tokens). Para
 * arquivos potencialmente grandes (o ZIP inteiro de um bot), usamos a API
 * nativa `crypto` do Node com AES-256-GCM: mais eficiente que crypto-js para
 * buffers grandes, e o modo GCM já entrega autenticação (authTag) — qualquer
 * byte alterado no arquivo (corrupção ou adulteração) faz a descriptografia
 * falhar explicitamente, em vez de silenciosamente devolver lixo.
 *
 * Reaproveita a mesma ENCRYPTION_KEY do .env (já validada no boot pelo
 * crypto.js — se chegou até aqui, sabemos que ela existe e tem tamanho ok).
 */
const crypto = require('crypto');
const config = require('../../config');

const PASSPHRASE = config.security.encryptionKey;
const SALT_LEN = 16;
const IV_LEN = 12;   // recomendado para GCM
const TAG_LEN = 16;
const KEY_LEN = 32;  // AES-256

/**
 * Deriva uma chave de 256 bits a partir da passphrase + salt usando scrypt.
 * Salt aleatório por arquivo (mais forte que salt fixo) — o custo de CPU do
 * scrypt é aceitável aqui porque backups não são criados a toda hora (já
 * limitados por rate limit em outro lugar do sistema).
 */
function deriveKey(salt) {
    return crypto.scryptSync(PASSPHRASE, salt, KEY_LEN);
}

/**
 * Criptografa um Buffer. Formato do arquivo resultante:
 * [salt(16)] [iv(12)] [authTag(16)] [ciphertext...]
 */
function encryptBuffer(plainBuffer) {
    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const key = deriveKey(salt);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Buffer.concat([salt, iv, authTag, ciphertext]);
}

/**
 * Descriptografa um Buffer no formato gerado por encryptBuffer().
 * Lança erro se o arquivo foi corrompido/adulterado (authTag não bate).
 */
function decryptBuffer(encryptedBuffer) {
    if (encryptedBuffer.length < SALT_LEN + IV_LEN + TAG_LEN) {
        throw new Error('Arquivo criptografado inválido ou truncado.');
    }

    const salt = encryptedBuffer.subarray(0, SALT_LEN);
    const iv = encryptedBuffer.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const authTag = encryptedBuffer.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
    const ciphertext = encryptedBuffer.subarray(SALT_LEN + IV_LEN + TAG_LEN);

    const key = deriveKey(salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    // Se o arquivo foi corrompido ou adulterado, isto lança um erro
    // ("Unsupported state or unable to authenticate data") em vez de
    // devolver dados incorretos silenciosamente.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Calcula o hash SHA-256 de um Buffer, em hexadecimal.
 * Usado para verificação de integridade independente da criptografia (ex:
 * mostrar ao usuário que o conteúdo restaurado bate exatamente com o que foi
 * salvo, mesmo que a camada de criptografia GCM já tenha validado o authTag).
 */
function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { encryptBuffer, decryptBuffer, sha256 };
