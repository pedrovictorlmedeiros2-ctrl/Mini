/**
 * PROOF MANAGER (Sistema Comercial — Fase 3)
 *
 * Upload e revisão de comprovantes de pagamento. Cada regra abaixo
 * corresponde a um requisito de segurança explícito desta fase:
 *
 * - Validação de DONO do pedido (IDOR): `submitProof()` só aceita um
 *   anexo de quem é `order.user_id` — nunca de outro cliente, mesmo que
 *   o `orderId` seja adivinhado/manipulado.
 * - Validação de tipo por CONTEÚDO, não só por nome/MIME declarado: o
 *   Discord informa `attachment.contentType`/`attachment.name`, mas
 *   ambos podem ser forjados por quem faz upload — os primeiros bytes
 *   do arquivo baixado são checados contra assinaturas conhecidas
 *   (magic numbers) antes de aceitar. Só uma allowlist estrita de
 *   imagem/PDF passa — nunca um executável, mesmo disfarçado de .jpg.
 * - Nunca depende só da URL temporária do Discord (~24h): o conteúdo é
 *   baixado e persistido no MOMENTO do envio.
 * - Armazenamento protegido: cifrado em repouso com `fileCrypto.js`
 *   (AES-256-GCM, mesma infra já usada pra backups) — nunca texto puro.
 * - Nunca disponível pra outro cliente: `getDecryptedProof()` exige
 *   `hasCommercePermission()` — comprovantes são revisados só pelo
 *   staff comercial, nunca expostos a outro cliente através de nenhuma
 *   função pública deste módulo.
 * - Toda visualização e todo recebimento são auditados.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { get, run, query } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');
const fileCrypto = require('../../utils/fileCrypto');
const config = require('../../../config');
const OrderManager = require('./OrderManager');
const CommerceStaffManager = require('./CommerceStaffManager');

// Allowlist estrita — cada entrada exige que EXTENSÃO, MIME declarado
// (quando presente) E os primeiros bytes reais do arquivo concordem
// entre si. Qualquer divergência é motivo de recusa, não só um alerta.
const ALLOWED_FILE_TYPES = [
    {
        mime: 'image/jpeg',
        extensions: ['.jpg', '.jpeg'],
        sniff: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
    },
    {
        mime: 'image/png',
        extensions: ['.png'],
        sniff: (buf) => buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
    },
    {
        mime: 'image/webp',
        extensions: ['.webp'],
        sniff: (buf) => buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP',
    },
    {
        mime: 'application/pdf',
        extensions: ['.pdf'],
        sniff: (buf) => buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === '%PDF',
    },
];

/** Detecta o tipo real pelo CONTEÚDO (magic bytes) — nunca confia em nome/MIME declarado sozinho. */
function detectFileType(buffer) {
    return ALLOWED_FILE_TYPES.find((type) => type.sniff(buffer)) || null;
}

function getProof(proofId) {
    return get('SELECT * FROM commerce_proofs WHERE id = ?', [proofId]);
}

function listProofsForOrder(orderId) {
    return query('SELECT * FROM commerce_proofs WHERE order_id = ? ORDER BY created_at ASC', [orderId]);
}

function getLatestProofForOrder(orderId) {
    const rows = listProofsForOrder(orderId);
    return rows.length ? rows[rows.length - 1] : null;
}

/**
 * Recebe um comprovante. `attachment` é o objeto de anexo do Discord.js
 * ({url, name, contentType, size}) — tratado como TOTALMENTE
 * adversarial: nada nele (nome, MIME declarado, tamanho declarado) é
 * confiado sem verificação independente contra o conteúdo real baixado.
 *
 * @param {number} orderId
 * @param {string} uploaderUserId - SEMPRE o interaction.user.id de quem enviou, nunca algo lido de input
 * @param {{url:string, name?:string, contentType?:string, size?:number}} attachment
 */
async function submitProof(orderId, uploaderUserId, attachment) {
    const order = OrderManager.getOrder(orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);

    // IDOR — o núcleo da proteção: o comprovante só pode ser enviado por
    // quem é o dono do pedido, checado contra o banco (nunca contra
    // algo que o próprio chamador possa ter alegado).
    if (order.user_id !== uploaderUserId) {
        recordAuditEvent({
            userId: uploaderUserId,
            event: 'commerce:proof_ownership_denied',
            details: JSON.stringify({ orderId, actualOwnerId: order.user_id }),
            severity: 'warning',
        });
        throw new Error('Você não é o dono deste pedido — não é possível enviar um comprovante para ele.');
    }

    if (![OrderManager.STATUS.AWAITING_PAYMENT, OrderManager.STATUS.PROOF_SUBMITTED].includes(order.status)) {
        throw new Error(`Pedido #${orderId} não está aceitando comprovante agora (status: ${order.status}).`);
    }

    if (!attachment || typeof attachment.url !== 'string' || !attachment.url) {
        throw new Error('Anexo inválido.');
    }

    const declaredSize = Number(attachment.size) || 0;
    if (declaredSize > 0 && declaredSize > config.commerce.maxProofSizeBytes) {
        throw new Error(`Arquivo muito grande (máx. ${Math.round(config.commerce.maxProofSizeBytes / (1024 * 1024))}MB).`);
    }

    const declaredExt = path.extname(String(attachment.name || '')).toLowerCase();
    const declaredMime = String(attachment.contentType || '').split(';')[0].trim().toLowerCase();

    // Baixa o conteúdo AGORA — nunca guarda só a URL temporária do
    // Discord (expira em ~24h) como referência persistente.
    const response = await fetch(attachment.url);
    if (!response.ok) {
        throw new Error('Falha ao baixar o anexo do Discord.');
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length === 0) throw new Error('Arquivo vazio.');
    if (buffer.length > config.commerce.maxProofSizeBytes) {
        throw new Error(`Arquivo muito grande (máx. ${Math.round(config.commerce.maxProofSizeBytes / (1024 * 1024))}MB).`);
    }

    // Validação por CONTEÚDO — a defesa real contra um executável (ou
    // qualquer outro tipo perigoso) disfarçado com nome/MIME de imagem.
    const detected = detectFileType(buffer);
    if (!detected) {
        recordAuditEvent({
            userId: uploaderUserId,
            event: 'commerce:proof_rejected_invalid_type',
            details: JSON.stringify({ orderId, declaredExt, declaredMime, sizeBytes: buffer.length }),
            severity: 'warning',
        });
        throw new Error('Tipo de arquivo não permitido. Envie uma imagem (JPG, PNG ou WEBP) ou um PDF.');
    }
    if (declaredExt && !detected.extensions.includes(declaredExt)) {
        throw new Error('A extensão do arquivo não corresponde ao conteúdo real dele.');
    }
    if (declaredMime && declaredMime !== detected.mime) {
        throw new Error('O tipo declarado do arquivo não corresponde ao conteúdo real dele.');
    }

    const proofId = crypto.randomUUID();
    const sha256 = fileCrypto.sha256(buffer);
    const encrypted = fileCrypto.encryptBuffer(buffer);

    const storageDir = path.resolve(config.commerce.proofsFolder);
    fs.mkdirSync(storageDir, { recursive: true });
    const storagePath = path.join(storageDir, `${proofId}.enc`);
    fs.writeFileSync(storagePath, encrypted);

    run(
        `INSERT INTO commerce_proofs (id, order_id, storage_path, sha256, mime_type, original_filename, size_bytes, uploaded_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [proofId, orderId, storagePath, sha256, detected.mime, String(attachment.name || '').slice(0, 200), buffer.length, uploaderUserId]
    );

    if (order.status === OrderManager.STATUS.AWAITING_PAYMENT) {
        OrderManager.transitionOrder(orderId, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.PROOF_SUBMITTED);
    }

    recordAuditEvent({
        userId: uploaderUserId,
        event: 'commerce:proof_received',
        details: JSON.stringify({ orderId, proofId, mimeType: detected.mime, sizeBytes: buffer.length }),
        severity: 'info',
    });

    return getProof(proofId);
}

/**
 * Decripta um comprovante pra revisão — SÓ staff comercial
 * (`hasCommercePermission`), checado aqui dentro (nunca confia que a UI
 * já checou). Nunca chamado a partir de nenhum fluxo do cliente — não
 * existe nenhuma função pública deste módulo que devolva o conteúdo de
 * um comprovante pra quem não seja staff, nem mesmo o próprio dono do
 * pedido.
 */
function getDecryptedProof(proofId, requestingUserId) {
    if (!CommerceStaffManager.hasCommercePermission(requestingUserId)) {
        throw new Error('Sem permissão comercial (admin ou COMMERCE_STAFF) para visualizar comprovantes.');
    }
    const proof = getProof(proofId);
    if (!proof) throw new Error(`Comprovante não encontrado: ${proofId}`);

    const encrypted = fs.readFileSync(proof.storage_path);
    const buffer = fileCrypto.decryptBuffer(encrypted);

    if (fileCrypto.sha256(buffer) !== proof.sha256) {
        throw new Error('Falha de integridade do comprovante — o hash armazenado não confere com o conteúdo decriptado.');
    }

    recordAuditEvent({
        userId: requestingUserId,
        event: 'commerce:proof_viewed',
        details: JSON.stringify({ proofId, orderId: proof.order_id }),
        severity: 'info',
    });

    return { buffer, mimeType: proof.mime_type, originalFilename: proof.original_filename };
}

/** Marca o comprovante mais recente do pedido como aceito/recusado — chamado por PaymentManager ao decidir. */
function markLatestProofStatus(orderId, status, reviewerUserId, reason = null) {
    const latest = getLatestProofForOrder(orderId);
    if (!latest) return null;
    run(
        'UPDATE commerce_proofs SET status = ?, reviewed_by_admin_id = ?, review_reason = ? WHERE id = ?',
        [status, reviewerUserId, reason, latest.id]
    );
    return getProof(latest.id);
}

module.exports = {
    ALLOWED_FILE_TYPES,
    detectFileType,
    getProof,
    listProofsForOrder,
    getLatestProofForOrder,
    submitProof,
    getDecryptedProof,
    markLatestProofStatus,
};
