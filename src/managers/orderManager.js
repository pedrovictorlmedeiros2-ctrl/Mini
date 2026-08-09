/**
 * GERENCIADOR DE PEDIDOS (CARRINHOS)
 * Gerencia o fluxo de compra, desde a criação do canal até a aprovação.
 */
const { get, run, query } = require('../database/database');

/**
 * Cria um novo pedido (carrinho)
 */
function createOrder(userId, channelId) {
    run(
        'INSERT INTO orders (user_id, channel_id, status) VALUES (?, ?, ?)',
        [userId, channelId, 'pending']
    );
    return get("SELECT * FROM orders WHERE channel_id = ?", [channelId]);
}

/**
 * Atualiza um pedido com o plano selecionado
 */
function updateOrderPlan(orderId, planId) {
    const plan = get("SELECT * FROM plans WHERE id = ?", [planId]);
    if (!plan) throw new Error('Plano não encontrado');

    // CORREÇÃO: ao trocar de plano, o cupom anteriormente aplicado (calculado
    // em cima do preço do plano ANTIGO) ficava "pendurado" em coupon_id mesmo
    // com o total_price resetado pro preço cheio do plano novo. Resultado: na
    // aprovação, o cupom era marcado como usado (incrementCouponUse) mesmo
    // sem o desconto nunca ter sido de fato aplicado ao novo total — queimando
    // o uso do cupom à toa. Agora limpamos o cupom ao trocar de plano; o
    // cliente precisa reaplicar (o que recalcula certo contra o preço novo).
    run(
        "UPDATE orders SET plan_id = ?, original_price = ?, total_price = ?, coupon_id = NULL, discount_amount = 0, updated_at = datetime('now') WHERE id = ?",
        [planId, plan.price, plan.price, orderId]
    );
}

/**
 * Aplica um cupom ao pedido
 */
function applyCouponToOrder(orderId, coupon) {
    const order = get("SELECT * FROM orders WHERE id = ?", [orderId]);
    if (!order || !order.original_price) throw new Error('Selecione um plano antes de aplicar o cupom.');

    const { calculateDiscount } = require('./couponManager');
    const discount = calculateDiscount(coupon, order.original_price);
    const total = order.original_price - discount;

    run(
        "UPDATE orders SET coupon_id = ?, discount_amount = ?, total_price = ?, updated_at = datetime('now') WHERE id = ?",
        [coupon.id, discount, total, orderId]
    );
}

/**
 * Obtém pedido pelo ID do canal
 */
function getOrderByChannel(channelId) {
    return get("SELECT * FROM orders WHERE channel_id = ?", [channelId]);
}

/**
 * Atualiza status do pedido
 */
function updateOrderStatus(orderId, status, extra = {}) {
    const fields = ['status = ?', "updated_at = datetime('now')"];
    const values = [status];

    if (extra.receipt_url) {
        fields.push('receipt_url = ?');
        values.push(extra.receipt_url);
    }
    if (extra.rejection_reason) {
        fields.push('rejection_reason = ?');
        values.push(extra.rejection_reason);
    }

    values.push(orderId);
    run(`UPDATE orders SET ${fields.join(', ')} WHERE id = ?`, values);
}

module.exports = {
    createOrder,
    updateOrderPlan,
    applyCouponToOrder,
    getOrderByChannel,
    updateOrderStatus
};
