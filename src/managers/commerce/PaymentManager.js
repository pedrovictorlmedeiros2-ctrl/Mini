/**
 * PAYMENT MANAGER (Sistema Comercial — Fase 2)
 *
 * Payment = o que se ESPERAVA receber (valor, dados Pix SNAPSHOTADOS no
 * momento em que o pedido entra em AWAITING_PAYMENT) + o veredito humano
 * sobre isso. Separado de Order (arquitetura §3) porque a v1 usa Pix
 * manual, mas o desenho já comporta um gateway automatizado no futuro
 * sem redesenhar Order.
 *
 * IMPORTANTE (invariante #1 desta fase): confirmar um Payment NUNCA
 * ativa um Entitlement. `confirmPayment()` só leva o Order até APPROVED
 * — a transição pra PROVISIONING/ACTIVE é responsabilidade exclusiva do
 * (futuro) ProvisioningManager, nunca deste módulo.
 *
 * NÃO implementa nesta fase: envio/revisão de comprovante (ProofManager,
 * fora de escopo) nem a interface Discord — só a camada de dados/regra
 * de negócio, testável diretamente. `openForReview`/`confirmPayment`/
 * `rejectPayment` são exatamente as funções que uma UI futura vai
 * chamar.
 */
const { get, run } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');
const OrderManager = require('./OrderManager');
const CommerceStaffManager = require('./CommerceStaffManager');
const CouponManager = require('./CouponManager');

const PAYMENT_STATUS = Object.freeze({
    AWAITING_PROOF: 'awaiting_proof',
    CONFIRMED: 'confirmed',
    REJECTED: 'rejected',
});

/**
 * Cria o registro de Payment pro pedido — chamado logo depois de
 * `OrderManager.confirmProduct()` (mesmo instante em que o total já é
 * conhecido). Os dados Pix são lidos de `sales_config` (reaproveitada
 * como está, sem mudança de schema — arquitetura §19) e SNAPSHOTADOS
 * aqui: uma mudança futura na chave Pix nunca altera o que este pedido
 * já mostrou ao cliente.
 */
function createPaymentRecord(orderId) {
    const order = OrderManager.getOrder(orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    if (order.status !== OrderManager.STATUS.AWAITING_PAYMENT) {
        throw new Error(`Pedido #${orderId} precisa estar AWAITING_PAYMENT para criar o registro de pagamento.`);
    }
    const existing = get('SELECT * FROM commerce_payments WHERE order_id = ?', [orderId]);
    if (existing) return existing; // idempotente — nunca duplica o snapshot Pix de um pedido

    const pixConfig = get('SELECT pix_key, pix_name, pix_city FROM sales_config WHERE id = 1') || {};

    run(`
        INSERT INTO commerce_payments (order_id, method, pix_key_snapshot, pix_name_snapshot, pix_city_snapshot, expected_amount, status)
        VALUES (?, 'pix', ?, ?, ?, ?, ?)
    `, [orderId, pixConfig.pix_key || null, pixConfig.pix_name || null, pixConfig.pix_city || null, order.total_price, PAYMENT_STATUS.AWAITING_PROOF]);

    recordAuditEvent({
        userId: null,
        event: 'commerce:payment_record_created',
        details: JSON.stringify({ orderId, expectedAmount: order.total_price }),
        severity: 'info',
    });
    return get('SELECT * FROM commerce_payments WHERE order_id = ?', [orderId]);
}

function getPaymentByOrder(orderId) {
    return get('SELECT * FROM commerce_payments WHERE order_id = ?', [orderId]);
}

/**
 * Marca o pedido como em revisão humana (PROOF_SUBMITTED → UNDER_REVIEW).
 * Requer permissão comercial — checada AQUI, dentro do manager, nunca só
 * confiando que a camada de UI já checou antes (invariante de segurança
 * #9 da arquitetura).
 */
function openForReview(orderId, reviewerUserId) {
    if (!CommerceStaffManager.hasCommercePermission(reviewerUserId)) {
        throw new Error('Usuário sem permissão comercial (admin ou COMMERCE_STAFF) para revisar pedidos.');
    }
    const order = OrderManager.transitionOrder(orderId, [OrderManager.STATUS.PROOF_SUBMITTED], OrderManager.STATUS.UNDER_REVIEW);
    if (!order) {
        throw new Error(`Pedido #${orderId} não está com comprovante enviado — não é possível abrir para revisão.`);
    }
    recordAuditEvent({
        userId: reviewerUserId,
        event: 'commerce:order_under_review',
        details: JSON.stringify({ orderId }),
        severity: 'info',
    });
    return order;
}

/**
 * Confirma o pagamento — a ÚNICA coisa que este método faz do lado do
 * Order é levá-lo a APPROVED (nunca ACTIVE, nunca PROVISIONING — isso é
 * do ProvisioningManager, fase seguinte). Incrementa o uso do cupom
 * (se houver) SÓ agora — nunca no momento em que o cliente aplicou o
 * cupom (ver CouponManager.confirmUsage para o porquê).
 */
function confirmPayment(orderId, reviewerUserId) {
    if (!CommerceStaffManager.hasCommercePermission(reviewerUserId)) {
        throw new Error('Usuário sem permissão comercial (admin ou COMMERCE_STAFF) para aprovar pagamentos.');
    }

    const order = OrderManager.transitionOrder(orderId, [OrderManager.STATUS.UNDER_REVIEW], OrderManager.STATUS.APPROVED);
    if (!order) {
        throw new Error(`Pedido #${orderId} não está em revisão — não é possível aprovar (já processado ou fora de ordem).`);
    }

    run(
        "UPDATE commerce_payments SET status = ?, confirmed_by_admin_id = ?, confirmed_at = datetime('now') WHERE order_id = ?",
        [PAYMENT_STATUS.CONFIRMED, reviewerUserId, orderId]
    );

    let couponWarning = null;
    if (order.coupon_id) {
        const { overLimit } = CouponManager.confirmUsage(order.coupon_id);
        if (overLimit) couponWarning = 'coupon_over_limit';
    }

    recordAuditEvent({
        userId: reviewerUserId,
        event: 'commerce:payment_confirmed',
        details: JSON.stringify({ orderId, couponWarning }),
        severity: 'info',
    });

    return { order, couponWarning };
}

/** Recusa o pagamento — motivo obrigatório, sempre auditado. */
function rejectPayment(orderId, reviewerUserId, reason) {
    if (!CommerceStaffManager.hasCommercePermission(reviewerUserId)) {
        throw new Error('Usuário sem permissão comercial (admin ou COMMERCE_STAFF) para recusar pagamentos.');
    }
    if (!reason || !reason.trim()) {
        throw new Error('Motivo da recusa é obrigatório.');
    }

    const order = OrderManager.transitionOrder(orderId, [OrderManager.STATUS.UNDER_REVIEW], OrderManager.STATUS.REJECTED, {
        rejection_reason: reason,
    });
    if (!order) {
        throw new Error(`Pedido #${orderId} não está em revisão — não é possível recusar (já processado ou fora de ordem).`);
    }

    run(
        "UPDATE commerce_payments SET status = ?, confirmed_by_admin_id = ?, confirmed_at = datetime('now'), rejection_reason = ? WHERE order_id = ?",
        [PAYMENT_STATUS.REJECTED, reviewerUserId, reason, orderId]
    );

    recordAuditEvent({
        userId: reviewerUserId,
        event: 'commerce:payment_rejected',
        details: JSON.stringify({ orderId, reason }),
        severity: 'info',
    });
    return order;
}

module.exports = {
    PAYMENT_STATUS,
    createPaymentRecord,
    getPaymentByOrder,
    openForReview,
    confirmPayment,
    rejectPayment,
};
