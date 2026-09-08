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

// SSRF (Fase 5 — achado da revisão adversarial final): `attachment.url`
// é tratado como adversarial igual a qualquer outro campo do anexo. Sem
// esta allowlist, nada impediria — por bug futuro, ou uma chamada deste
// manager fora do fluxo normal do Discord.js — que `submitProof()`
// fizesse o SERVIDOR baixar uma URL arbitrária (rede interna, metadata
// de nuvem, um host que devolve um arquivo gigante pra esgotar memória).
// Anexos reais do Discord SEMPRE vêm de um desses dois hosts de CDN —
// qualquer coisa fora disso é recusada antes mesmo de tentar o fetch.
const ALLOWED_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

function isAllowedAttachmentUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return parsed.protocol === 'https:' && ALLOWED_ATTACHMENT_HOSTS.has(parsed.hostname);
    } catch {
        return false;
    }
}

/**
 * Sanitiza o nome de exibição de um comprovante (Fase 5). NUNCA é usado
 * pra montar um caminho de arquivo real (o nome interno em disco é
 * sempre `${crypto.randomUUID()}.enc` — ver `submitProof`), mas ainda
 * assim precisa ser seguro porque é reexibido pra staff (nome do anexo
 * em `getDecryptedProof`/`AttachmentBuilder`) e persistido no banco:
 * - `path.basename` descarta qualquer componente de diretório (cobre
 *   "../../etc/passwd", "/etc/passwd", "C:\\Windows\\x" etc. — em
 *   qualquer um desses casos, o pior resultado possível já é só o nome
 *   final, nunca um caminho).
 * - Normaliza Unicode (NFC) e remove caracteres de controle (0x00-0x1F,
 *   0x7F) — nomes forjados com caracteres invisíveis/de controle nunca
 *   chegam a ser exibidos ou guardados como vieram.
 * - Trunca pra um tamanho razoável — nomes gigantes nunca inflam o banco
 *   nem a resposta ao staff.
 */
function sanitizeFilename(rawName) {
    const base = path.basename(String(rawName || ''));
    const normalized = base.normalize('NFC').replace(/[\x00-\x1f\x7f]/g, '').trim();
    const safe = normalized.slice(0, 150);
    return safe || 'comprovante';
}

// Estados do PEDIDO em que um comprovante pode ser recebido (Fase 6:
// inclui NEEDS_NEW_PROOF — o staff pediu um novo comprovante, o antigo
// não serviu, mas o pedido não foi recusado em definitivo). REJECTED
// NUNCA entra aqui de propósito — um pedido definitivamente recusado
// nunca aceita um novo comprovante, isso não é uma transição válida na
// máquina de estados (OrderManager.VALID_TRANSITIONS não tem
// REJECTED → nada).
const PROOF_ACCEPTING_STATUSES = [
    OrderManager.STATUS.AWAITING_PAYMENT,
    OrderManager.STATUS.PROOF_SUBMITTED,
    OrderManager.STATUS.NEEDS_NEW_PROOF,
];

function getProof(proofId) {
    return get('SELECT * FROM commerce_proofs WHERE id = ?', [proofId]);
}

function listProofsForOrder(orderId) {
    // Ordena por rowid, não só por created_at: `created_at` tem
    // granularidade de segundo (datetime('now') do SQLite) — duas
    // submissões concorrentes pro mesmo pedido podem cair no MESMO
    // segundo, e sem um desempate determinístico, qual delas conta como
    // "a mais recente" (getLatestProofForOrder) ficaria indefinido. O
    // rowid implícito do SQLite (a tabela não é WITHOUT ROWID) sempre
    // reflete a ordem real de inserção, então o desempate é exato mesmo
    // sob concorrência real.
    return query('SELECT *, rowid FROM commerce_proofs WHERE order_id = ? ORDER BY created_at ASC, rowid ASC', [orderId]);
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

    if (!PROOF_ACCEPTING_STATUSES.includes(order.status)) {
        throw new Error(`Pedido #${orderId} não está aceitando comprovante agora (status: ${order.status}).`);
    }

    if (!attachment || typeof attachment.url !== 'string' || !attachment.url) {
        throw new Error('Anexo inválido.');
    }
    if (!isAllowedAttachmentUrl(attachment.url)) {
        recordAuditEvent({
            userId: uploaderUserId,
            event: 'commerce:proof_rejected_invalid_url',
            details: JSON.stringify({ orderId }),
            severity: 'warning',
        });
        throw new Error('URL do anexo inválida — só anexos do CDN oficial do Discord são aceitos.');
    }

    const declaredSize = Number(attachment.size) || 0;
    if (declaredSize > 0 && declaredSize > config.commerce.maxProofSizeBytes) {
        throw new Error(`Arquivo muito grande (máx. ${Math.round(config.commerce.maxProofSizeBytes / (1024 * 1024))}MB).`);
    }

    // A extensão declarada é extraída do nome BRUTO (path.extname não
    // muda com sanitização — só remove diretório, que não afeta a
    // extensão) porque é comparada contra o conteúdo real abaixo; o nome
    // gravado/exibido depois (original_filename) usa a versão
    // SANITIZADA, nunca o valor bruto.
    const declaredExt = path.extname(String(attachment.name || '')).toLowerCase();
    const declaredMime = String(attachment.contentType || '').split(';')[0].trim().toLowerCase();
    const safeOriginalFilename = sanitizeFilename(attachment.name);

    // Baixa o conteúdo AGORA — nunca guarda só a URL temporária do
    // Discord (expira em ~24h) como referência persistente. Qualquer
    // falha de rede/URL expirada é convertida numa mensagem clara — nunca
    // deixa um erro bruto de fetch() vazar, e nada é escrito em disco até
    // aqui (nenhum arquivo parcial/corrompido pode sobrar de um download
    // que falhou).
    let response;
    try {
        response = await fetch(attachment.url);
    } catch {
        throw new Error('Falha ao baixar o anexo do Discord (a URL pode ter expirado ou a rede falhou). Tente enviar o comprovante de novo.');
    }
    if (!response.ok) {
        throw new Error('Falha ao baixar o anexo do Discord (a URL pode ter expirado). Tente enviar o comprovante de novo.');
    }
    // Checagem antecipada pelo header Content-Length, quando presente —
    // evita puxar um corpo gigante inteiro pra memória só pra descobrir
    // depois que ele excede o limite. Não substitui a checagem em
    // `buffer.length` abaixo (o header pode faltar ou estar errado) — é
    // só uma saída mais barata no caso comum.
    const contentLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(contentLength) && contentLength > config.commerce.maxProofSizeBytes) {
        throw new Error(`Arquivo muito grande (máx. ${Math.round(config.commerce.maxProofSizeBytes / (1024 * 1024))}MB).`);
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

    // RE-VALIDAÇÃO PERSISTENTE (Fase 5 — garantia contra corrida real,
    // não só a otimização de UI): entre o início desta função e este
    // ponto houve pelo menos um `await` real (o download do anexo, que
    // pode levar segundos) — nesse intervalo o pedido pode ter mudado de
    // estado por outro caminho (staff abriu revisão concorrentemente,
    // cliente cancelou, o CommerceScheduler expirou o carrinho). Reconfere
    // contra o banco AGORA, de forma síncrona e imediatamente antes da
    // escrita — nenhum `await` entre esta leitura e o INSERT abaixo, então
    // não existe nova janela de corrida aqui (Node é single-threaded e o
    // driver SQLite é síncrono). O lock em memória da camada de UI
    // (commerce.js) é só uma otimização pra UX — esta é a garantia real.
    const freshOrder = OrderManager.getOrder(orderId);
    if (!freshOrder || !PROOF_ACCEPTING_STATUSES.includes(freshOrder.status)) {
        recordAuditEvent({
            userId: uploaderUserId,
            event: 'commerce:proof_rejected_stale_state',
            details: JSON.stringify({ orderId, statusAtReceive: freshOrder ? freshOrder.status : null }),
            severity: 'warning',
        });
        throw new Error(`Pedido #${orderId} não está mais aceitando comprovante (o estado mudou durante o envio: ${freshOrder ? freshOrder.status : 'removido'}).`);
    }

    const proofId = crypto.randomUUID();
    const sha256 = fileCrypto.sha256(buffer);
    const encrypted = fileCrypto.encryptBuffer(buffer);

    // Diretório privado, fora de qualquer pasta servida publicamente —
    // nenhuma rota HTTP nesta fase serve `config.commerce.proofsFolder`.
    // Permissões restritivas (0700/0600): mesmo num ambiente
    // multiusuário, só o processo dono consegue ler o diretório/arquivo.
    // Nome do arquivo SEMPRE `${uuid}.enc` — nunca derivado do nome
    // enviado pelo cliente (isso por si só já neutraliza qualquer
    // tentativa de path traversal via nome de arquivo). Flag 'wx' faz a
    // escrita FALHAR se o caminho já existir, em vez de sobrescrever —
    // defesa em profundidade contra uma colisão de UUID (praticamente
    // impossível) ou qualquer bug futuro que gere o mesmo id duas vezes.
    const storageDir = path.resolve(config.commerce.proofsFolder);
    fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(storageDir, 0o700); } catch { /* melhor esforço — não bloqueia em ambientes restritos */ }
    const storagePath = path.join(storageDir, `${proofId}.enc`);
    fs.writeFileSync(storagePath, encrypted, { mode: 0o600, flag: 'wx' });

    run(
        `INSERT INTO commerce_proofs (id, order_id, storage_path, sha256, mime_type, original_filename, size_bytes, uploaded_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [proofId, orderId, storagePath, sha256, detected.mime, safeOriginalFilename, buffer.length, uploaderUserId]
    );

    if (freshOrder.status === OrderManager.STATUS.AWAITING_PAYMENT) {
        OrderManager.transitionOrder(orderId, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.PROOF_SUBMITTED);
    } else if (freshOrder.status === OrderManager.STATUS.NEEDS_NEW_PROOF) {
        // Reenvio depois de o staff pedir um novo comprovante (Fase 6) —
        // volta DIRETO pra UNDER_REVIEW (o pedido já tinha sido aberto
        // pra revisão antes; um novo comprovante só substitui o motivo
        // de estar esperando, não reabre a fila de "aguardando triagem").
        // O comprovante anterior nunca é apagado — só uma linha nova é
        // inserida (ver histórico preservado acima).
        OrderManager.transitionOrder(orderId, [OrderManager.STATUS.NEEDS_NEW_PROOF], OrderManager.STATUS.UNDER_REVIEW);
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
        // Auditoria da tentativa NEGADA (Fase 5) — cobre tanto um cliente
        // comum quanto um staff já revogado tentando acessar; nunca grava
        // o conteúdo do comprovante, só o fato da tentativa e quem tentou.
        recordAuditEvent({
            userId: requestingUserId,
            event: 'commerce:proof_access_denied',
            details: JSON.stringify({ proofId }),
            severity: 'warning',
        });
        throw new Error('Sem permissão comercial (admin ou COMMERCE_STAFF) para visualizar comprovantes.');
    }
    const proof = getProof(proofId);
    if (!proof) throw new Error(`Comprovante não encontrado: ${proofId}`);
    if (proof.purged_at) {
        throw new Error('Este comprovante já foi removido por retenção — não está mais disponível para visualização (o pedido continua auditável).');
    }

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

/**
 * Retenção (Fase 5) — apaga só o ARQUIVO cifrado em disco de
 * comprovantes já REVISADOS ('accepted'/'rejected') mais velhos que
 * `config.commerce.proofRetentionDays`. Um comprovante 'submitted'
 * (aguardando revisão) NUNCA é purgado, não importa a idade — apagar a
 * única evidência de um pedido ainda pendente seria destruir algo que
 * pode ser necessário pra decidir o próprio pedido. A LINHA no banco
 * nunca é apagada (mantém o histórico de auditoria de que aquele
 * comprovante existiu, foi recebido e revisado); só `storage_path` some
 * e `purged_at` é gravado, o que já faz `getDecryptedProof` recusar
 * qualquer tentativa de leitura depois.
 */
function purgeExpiredProofs() {
    const days = config.commerce.proofRetentionDays;
    const candidates = query(
        `SELECT * FROM commerce_proofs WHERE purged_at IS NULL AND status IN ('accepted','rejected') AND created_at <= datetime('now', ?)`,
        [`-${days} days`]
    );

    let purgedCount = 0;
    for (const proof of candidates) {
        try {
            if (fs.existsSync(proof.storage_path)) {
                fs.unlinkSync(proof.storage_path);
            }
            run("UPDATE commerce_proofs SET purged_at = datetime('now') WHERE id = ?", [proof.id]);
            purgedCount += 1;
        } catch (err) {
            // Não interrompe a varredura por causa de um arquivo — loga e
            // tenta de novo na próxima execução (nunca marca purged_at se
            // o arquivo não foi de fato removido).
            console.error(`[ProofManager] Falha ao purgar comprovante ${proof.id} pela retenção:`, err.message);
        }
    }

    if (purgedCount) {
        recordAuditEvent({
            userId: null,
            event: 'commerce:proof_purged',
            details: JSON.stringify({ count: purgedCount, retentionDays: days }),
            severity: 'info',
        });
    }
    return purgedCount;
}

module.exports = {
    ALLOWED_FILE_TYPES,
    detectFileType,
    sanitizeFilename,
    getProof,
    listProofsForOrder,
    getLatestProofForOrder,
    submitProof,
    getDecryptedProof,
    markLatestProofStatus,
    purgeExpiredProofs,
};
