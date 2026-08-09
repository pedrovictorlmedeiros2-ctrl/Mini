/**
 * BACKUP OFFSITE — S3-compatible (AWS S3, Cloudflare R2, MinIO, Backblaze B2)
 *
 * Usa a API S3 via HTTPS puro (sem SDK pesado): PutObject com AWS Signature V4.
 * Configure:
 *   OFFSITE_BACKUP_ENABLED=true
 *   S3_ENDPOINT=https://xxx.r2.cloudflarestorage.com
 *   S3_BUCKET=hosting-backups
 *   S3_ACCESS_KEY=...
 *   S3_SECRET_KEY=...
 *   S3_REGION=auto
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

function enabled() {
    const v = String(process.env.OFFSITE_BACKUP_ENABLED || '').toLowerCase();
    return (v === 'true' || v === '1') && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY;
}

function hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

function getSignatureKey(secret, dateStamp, region, service) {
    const kDate = hmac('AWS4' + secret, dateStamp);
    const kRegion = hmac(kDate, region);
    const kService = hmac(kRegion, service);
    return hmac(kService, 'aws4_request');
}

/**
 * Upload de um arquivo local para o bucket (PutObject).
 * @returns {Promise<{key: string, etag?: string}>}
 */
async function uploadFile(localPath, objectKey) {
    if (!enabled()) throw new Error('Offsite backup não configurado');

    const endpoint = (process.env.S3_ENDPOINT || '').replace(/\/$/, '');
    const bucket = process.env.S3_BUCKET;
    const region = process.env.S3_REGION || 'auto';
    const accessKey = process.env.S3_ACCESS_KEY;
    const secretKey = process.env.S3_SECRET_KEY;

    const body = fs.readFileSync(localPath);
    const host = endpoint ? new URL(endpoint).host : `${bucket}.s3.${region}.amazonaws.com`;
    const urlPath = endpoint
        ? `/${bucket}/${objectKey.split('/').map(encodeURIComponent).join('/')}`
        : `/${objectKey.split('/').map(encodeURIComponent).join('/')}`;

    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body);

    const canonicalHeaders =
        `host:${host}\n` +
        `x-amz-content-sha256:${payloadHash}\n` +
        `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
        'PUT',
        urlPath,
        '',
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = getSignatureKey(secretKey, dateStamp, region, 's3');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

    const authorization =
        `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const base = endpoint || `https://${host}`;
    const fullUrl = `${base}${urlPath}`;

    return new Promise((resolve, reject) => {
        const u = new URL(fullUrl);
        const lib = u.protocol === 'http:' ? http : https;
        const req = lib.request(
            {
                method: 'PUT',
                hostname: u.hostname,
                port: u.port || undefined,
                path: u.pathname + u.search,
                headers: {
                    Host: host,
                    'Content-Length': body.length,
                    'x-amz-content-sha256': payloadHash,
                    'x-amz-date': amzDate,
                    Authorization: authorization,
                    'Content-Type': 'application/octet-stream',
                },
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ key: objectKey, etag: res.headers.etag, status: res.statusCode });
                    } else {
                        reject(new Error(`S3 upload falhou (${res.statusCode}): ${data.slice(0, 300)}`));
                    }
                });
            }
        );
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/**
 * Envia um backup local recém-criado para o offsite (best-effort).
 */
async function pushBackupOffsite(localPath, botCode) {
    if (!enabled()) return null;
    try {
        const base = path.basename(localPath);
        const key = `backups/${botCode || 'unknown'}/${base}`;
        const result = await uploadFile(localPath, key);
        console.log(`[OFFSITE] Backup enviado: s3://${process.env.S3_BUCKET}/${key}`);
        return result;
    } catch (err) {
        console.error('[OFFSITE] Falha no upload:', err.message);
        return null;
    }
}

module.exports = { enabled, uploadFile, pushBackupOffsite };
