/**
 * COUPON MANAGER (Sistema Comercial — Fase 2)
 *
 * Reaproveita a MESMA tabela `coupons` do sistema legado (nenhuma coluna
 * nova — arquitetura aprovada, COMMERCIAL_ARCHITECTURE_PROPOSAL.md §2) e
 * a mesma lógica de cálculo já usada e testada em produção pelo
 * `couponManager.js` legado. Reimplementado aqui (em vez de importar o
 * arquivo legado direto) pra manter `src/managers/commerce/` como uma
 * fronteira de módulo independente do fluxo de vendas antigo (§15/§19 da
 * arquitetura — isolamento do sistema comercial) — os dois lêem/escrevem
 * a mesma tabela, mas nunca se importam um ao outro.
 *
 * Invariante de arquitetura (#11): cupom nunca é referenciado por
 * `commerce_payments` nem por nenhuma tentativa de provisionamento — só
 * por `commerce_orders.coupon_id`, na precificação. Este módulo nunca
 * toca em `commerce_payments`.
 */
const { get, run } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');

/**
 * Valida um cupom pelo código. Lança com uma mensagem específica pra
 * cada motivo de invalidez — nunca incrementa uso aqui (isso só
 * acontece em confirmUsage(), no momento em que o pagamento é
 * confirmado de verdade — ver o comentário de confirmUsage()).
 */
function validateCoupon(code) {
    if (typeof code !== 'string' || !code.trim()) {
        throw new Error('Código de cupom inválido.');
    }
    const coupon = get('SELECT * FROM coupons WHERE code = ?', [code.trim().toUpperCase()]);

    if (!coupon) throw new Error('Cupom não encontrado.');
    if (coupon.status !== 'active') throw new Error('Este cupom está inativo.');
    if (coupon.max_uses > 0 && coupon.current_uses >= coupon.max_uses) {
        throw new Error('Este cupom atingiu o limite máximo de usos.');
    }
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
        throw new Error('Este cupom expirou.');
    }
    return coupon;
}

/** Calcula o desconto — nunca deixa o desconto exceder o preço original. */
function calculateDiscount(coupon, originalPrice) {
    if (typeof originalPrice !== 'number' || !Number.isFinite(originalPrice) || originalPrice < 0) {
        throw new Error('originalPrice inválido para cálculo de desconto.');
    }
    let discount = coupon.type === 'percentage'
        ? (originalPrice * coupon.value) / 100
        : coupon.value;
    return Math.max(0, Math.min(discount, originalPrice));
}

/**
 * Incrementa o uso do cupom — chamado SÓ no momento em que o pagamento é
 * de fato confirmado (PaymentManager.confirmPayment()), NUNCA no momento
 * em que o cliente aplica o cupom ao carrinho. Pedidos ficam em
 * AWAITING_PAYMENT/UNDER_REVIEW por tempo indeterminado (revisão
 * humana) — vários clientes podem aplicar o mesmo cupom de uso único
 * antes de qualquer confirmação; se o limite fosse checado só na
 * aplicação, todos passariam e o limite estouraria sem aviso (mesma
 * classe de bug já corrigida uma vez no admin.js legado). Revalida o
 * limite aqui e avisa (não bloqueia — o pagamento já foi confirmado por
 * um humano nesse ponto).
 *
 * @returns {{overLimit: boolean}}
 */
function confirmUsage(couponId) {
    const coupon = get('SELECT * FROM coupons WHERE id = ?', [couponId]);
    if (!coupon) throw new Error(`Cupom não encontrado: ${couponId}`);

    const overLimit = coupon.max_uses > 0 && coupon.current_uses >= coupon.max_uses;
    run('UPDATE coupons SET current_uses = current_uses + 1 WHERE id = ?', [couponId]);

    if (overLimit) {
        recordAuditEvent({
            userId: null,
            event: 'commerce:coupon_over_limit',
            details: JSON.stringify({ couponId, code: coupon.code, maxUses: coupon.max_uses, currentUses: coupon.current_uses }),
            severity: 'warning',
        });
    }
    return { overLimit };
}

module.exports = {
    validateCoupon,
    calculateDiscount,
    confirmUsage,
};
