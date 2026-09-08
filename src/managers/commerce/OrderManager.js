/**
 * ORDER MANAGER (Sistema Comercial — Fase 2)
 *
 * Máquina de estados do pedido — ver COMMERCIAL_ARCHITECTURE_PROPOSAL.md
 * §3. Este módulo é o ÚNICO lugar do sistema que executa
 * `UPDATE commerce_orders SET status = ...` (invariante de segurança #5
 * da arquitetura aprovada) — todo mundo (PaymentManager,
 * EntitlementManager indiretamente, CommerceScheduler, e no futuro
 * ProvisioningManager/commerce.js) passa por transitionOrder().
 *
 * transitionOrder() é um compare-and-swap atômico: um único
 * `UPDATE ... WHERE status IN (...)`. Como o driver SQLite usado
 * (node:sqlite) é síncrono e Node é single-threaded, não existe janela
 * de corrida real entre o check e o lock dentro do mesmo trecho síncrono
 * — é o mesmo princípio já usado (e corrigido) no fluxo de vendas
 * legado (admin.js, `admin_approve_`), só que formalizado aqui como o
 * único primitivo de transição, em vez de cada chamador reimplementar.
 *
 * Preço NUNCA é aceito como parâmetro de fora — confirmProduct() sempre
 * deriva do ProductCatalog pelo productId (invariante #4 da arquitetura).
 */
const { get, run, query } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');
const ProductCatalog = require('./ProductCatalog');

const STATUS = Object.freeze({
    DRAFT: 'DRAFT',
    AWAITING_PAYMENT: 'AWAITING_PAYMENT',
    PROOF_SUBMITTED: 'PROOF_SUBMITTED',
    UNDER_REVIEW: 'UNDER_REVIEW',
    // Fase 6 — rejeição "leve": o comprovante enviado não serve (ilegível,
    // valor não bate etc.) mas o pedido em si não foi recusado em
    // definitivo. Distinto de REJECTED (terminal, sem volta) — aqui o
    // cliente pode enviar um novo comprovante e o pedido volta pra
    // revisão. Ver ProofManager.submitProof() e PaymentManager.requestNewProof().
    NEEDS_NEW_PROOF: 'NEEDS_NEW_PROOF',
    APPROVED: 'APPROVED',
    PROVISIONING: 'PROVISIONING',
    ACTIVE: 'ACTIVE',
    PROVISIONING_FAILED: 'PROVISIONING_FAILED',
    REJECTED: 'REJECTED',
    CANCELLED: 'CANCELLED',
    EXPIRED: 'EXPIRED',
});

// Única fonte de verdade da máquina de estados. Qualquer transição fora
// desta tabela é recusada por transitionOrder() — nunca um UPDATE livre.
const VALID_TRANSITIONS = Object.freeze({
    [STATUS.DRAFT]: [STATUS.AWAITING_PAYMENT, STATUS.CANCELLED],
    [STATUS.AWAITING_PAYMENT]: [STATUS.PROOF_SUBMITTED, STATUS.CANCELLED, STATUS.EXPIRED],
    [STATUS.PROOF_SUBMITTED]: [STATUS.UNDER_REVIEW, STATUS.CANCELLED],
    [STATUS.UNDER_REVIEW]: [STATUS.PROOF_SUBMITTED, STATUS.NEEDS_NEW_PROOF, STATUS.APPROVED, STATUS.REJECTED],
    // Volta pra UNDER_REVIEW assim que o cliente reenvia (ProofManager) —
    // ou o cliente desiste e cancela, mesma janela que já valia em
    // PROOF_SUBMITTED (ainda não é uma decisão final do staff).
    [STATUS.NEEDS_NEW_PROOF]: [STATUS.UNDER_REVIEW, STATUS.CANCELLED],
    [STATUS.APPROVED]: [STATUS.PROVISIONING],
    [STATUS.PROVISIONING]: [STATUS.ACTIVE, STATUS.PROVISIONING_FAILED],
    [STATUS.PROVISIONING_FAILED]: [STATUS.PROVISIONING],
    [STATUS.ACTIVE]: [],
    [STATUS.REJECTED]: [],
    [STATUS.CANCELLED]: [],
    [STATUS.EXPIRED]: [],
});

const TERMINAL_STATUSES = Object.freeze([STATUS.ACTIVE, STATUS.REJECTED, STATUS.CANCELLED, STATUS.EXPIRED]);

/** Cria um pedido novo — sempre nasce em DRAFT, sem produto selecionado. */
function createOrder({ userId, channelId, guildId = null }) {
    if (!userId || !channelId) {
        throw new Error('OrderManager.createOrder requer userId e channelId.');
    }
    run(
        'INSERT INTO commerce_orders (guild_id, user_id, channel_id, status) VALUES (?, ?, ?, ?)',
        [guildId, userId, channelId, STATUS.DRAFT]
    );
    const order = get('SELECT * FROM commerce_orders WHERE channel_id = ?', [channelId]);
    recordAuditEvent({
        userId,
        event: 'commerce:order_created',
        details: JSON.stringify({ orderId: order.id, guildId }),
        severity: 'info',
    });
    return order;
}

function getOrder(orderId) {
    return get('SELECT * FROM commerce_orders WHERE id = ?', [orderId]);
}

function getOrderByChannel(channelId) {
    return get('SELECT * FROM commerce_orders WHERE channel_id = ?', [channelId]);
}

/**
 * O ÚNICO primitivo de transição de status. CAS atômico via
 * `WHERE status IN (fromStatuses)` — se `changes === 0`, outra chamada
 * (concorrente ou anterior) já mudou o status antes; o chamador NUNCA
 * deve tratar isso como uma exceção genérica, só como "não foi desta
 * vez" (retorna `null`, nunca lança por conta de concorrência perdida).
 *
 * Valida a transição contra VALID_TRANSITIONS antes de tentar o UPDATE —
 * uma transição não-mapeada é um erro de PROGRAMAÇÃO (lança), diferente
 * de "perdeu a corrida" (retorna null).
 *
 * @param {number} orderId
 * @param {string[]} fromStatuses - de quais estados a transição é válida
 * @param {string} toStatus
 * @param {object} [extraFields] - colunas adicionais a atualizar no mesmo UPDATE (ex.: rejection_reason)
 * @returns {object|null} o pedido já atualizado, ou null se a transição não aconteceu (corrida perdida)
 */
function transitionOrder(orderId, fromStatuses, toStatus, extraFields = {}) {
    if (!Array.isArray(fromStatuses) || fromStatuses.length === 0) {
        throw new Error('transitionOrder requer um array não-vazio de fromStatuses.');
    }
    if (!Object.values(STATUS).includes(toStatus)) {
        throw new Error(`transitionOrder: toStatus inválido: "${toStatus}".`);
    }
    for (const from of fromStatuses) {
        if (!VALID_TRANSITIONS[from] || !VALID_TRANSITIONS[from].includes(toStatus)) {
            throw new Error(`transitionOrder: transição "${from}" → "${toStatus}" não é válida na máquina de estados.`);
        }
    }

    const setClauses = ['status = ?', "updated_at = datetime('now')"];
    const values = [toStatus];
    for (const [column, value] of Object.entries(extraFields)) {
        setClauses.push(`${column} = ?`);
        values.push(value);
    }
    const placeholders = fromStatuses.map(() => '?').join(', ');
    values.push(orderId, ...fromStatuses);

    const result = run(
        `UPDATE commerce_orders SET ${setClauses.join(', ')} WHERE id = ? AND status IN (${placeholders})`,
        values
    );

    if (!result || result.changes === 0) {
        return null; // corrida perdida, ou pedido já não estava em nenhum dos fromStatuses — nunca lança por isso
    }

    const order = getOrder(orderId);
    recordAuditEvent({
        userId: null,
        event: 'commerce:order_transitioned',
        details: JSON.stringify({ orderId, fromStatuses, toStatus }),
        severity: 'info',
    });
    return order;
}

/**
 * Confirma o produto escolhido — grava o snapshot IMUTÁVEL (§6 da
 * arquitetura) e calcula o preço. Preço NUNCA vem de fora; sempre
 * derivado de ProductCatalog pelo productId (nunca aceita um valor
 * numérico como parâmetro).
 *
 * @param {number} orderId
 * @param {string} productId
 * @param {number|null} [renewalOfEntitlementId] - se for uma renovação, o entitlement sendo renovado
 */
function confirmProduct(orderId, productId, renewalOfEntitlementId = null) {
    const snapshot = ProductCatalog.buildProductSnapshot(productId); // lança se produto inexistente/arquivado
    const price = snapshot.price;

    const order = transitionOrder(orderId, [STATUS.DRAFT], STATUS.AWAITING_PAYMENT, {
        product_id: productId,
        product_snapshot: JSON.stringify(snapshot),
        renewal_of_entitlement_id: renewalOfEntitlementId,
        original_price: price,
        discount_amount: 0,
        total_price: price,
    });

    if (!order) {
        throw new Error(`Pedido #${orderId} não está em DRAFT — não é possível confirmar o produto.`);
    }

    recordAuditEvent({
        userId: null,
        event: 'commerce:product_confirmed',
        details: JSON.stringify({ orderId, productId, price, renewalOfEntitlementId }),
        severity: 'info',
    });
    return order;
}

/**
 * Aplica um cupom ao pedido — recalcula discount_amount/total_price a
 * partir de original_price (o snapshot do produto), nunca do preço
 * "ao vivo". Não muda o status do pedido. Só válido enquanto
 * AWAITING_PAYMENT (antes do comprovante ser enviado).
 */
function applyCoupon(orderId, couponId, discountAmount) {
    const order = getOrder(orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    if (order.status !== STATUS.AWAITING_PAYMENT) {
        throw new Error(`Pedido #${orderId} não está aguardando pagamento — não é possível aplicar cupom.`);
    }
    if (order.original_price == null) {
        throw new Error(`Pedido #${orderId} ainda não tem um produto confirmado.`);
    }

    const total = Math.max(0, order.original_price - discountAmount);
    run(
        "UPDATE commerce_orders SET coupon_id = ?, discount_amount = ?, total_price = ?, updated_at = datetime('now') WHERE id = ?",
        [couponId, discountAmount, total, orderId]
    );
    recordAuditEvent({
        userId: null,
        event: 'commerce:coupon_applied',
        details: JSON.stringify({ orderId, couponId, discountAmount, total }),
        severity: 'info',
    });
    return getOrder(orderId);
}

/** Remove o cupom aplicado, voltando o total pro preço cheio do snapshot. */
function removeCoupon(orderId) {
    const order = getOrder(orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    if (order.status !== STATUS.AWAITING_PAYMENT) {
        throw new Error(`Pedido #${orderId} não está aguardando pagamento — não é possível remover cupom.`);
    }
    run(
        "UPDATE commerce_orders SET coupon_id = NULL, discount_amount = 0, total_price = original_price, updated_at = datetime('now') WHERE id = ?",
        [orderId]
    );
    return getOrder(orderId);
}

/**
 * Cancelamento pelo CLIENTE — só permitido antes de UNDER_REVIEW (uma
 * vez em análise, só o staff decide via aprovar/recusar — ver matriz de
 * permissões da arquitetura). Cancelamento depois disso é uma decisão
 * administrativa, fora do escopo desta função.
 */
function cancelOrder(orderId) {
    const order = transitionOrder(
        orderId,
        [STATUS.DRAFT, STATUS.AWAITING_PAYMENT, STATUS.PROOF_SUBMITTED, STATUS.NEEDS_NEW_PROOF],
        STATUS.CANCELLED
    );
    if (!order) {
        throw new Error(`Pedido #${orderId} não pode mais ser cancelado pelo cliente (já está em análise ou finalizado).`);
    }
    return order;
}

module.exports = {
    STATUS,
    VALID_TRANSITIONS,
    TERMINAL_STATUSES,
    createOrder,
    getOrder,
    getOrderByChannel,
    transitionOrder,
    confirmProduct,
    applyCoupon,
    removeCoupon,
    cancelOrder,
};
