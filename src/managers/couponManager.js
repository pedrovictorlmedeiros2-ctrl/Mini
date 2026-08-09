/**
 * GERENCIADOR DE CUPONS
 * Cria e valida cupons de desconto.
 */
const { get, run, query } = require('../database/database');

/**
 * Cria um novo cupom
 */
function createCoupon(data) {
    // Mesma proteção defensiva aplicada em savePlan: nunca deixamos `undefined`
    // ir pro SQLite (o driver nativo rejeita, precisa ser `null`).
    const { code, type, value, max_uses = 0, expires_at = null } = data;
    run(`
        INSERT INTO coupons (code, type, value, max_uses, expires_at)
        VALUES (?, ?, ?, ?, ?)
    `, [code.toUpperCase(), type, value, max_uses, expires_at]);
}

/**
 * Valida um cupom
 * @returns {Object|null} Retorna o cupom se for válido, ou lança erro
 */
function validateCoupon(code) {
    const coupon = get("SELECT * FROM coupons WHERE code = ?", [code.toUpperCase()]);
    
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

/**
 * Aplica o desconto de um cupom a um valor
 */
function calculateDiscount(coupon, originalPrice) {
    let discount = 0;
    if (coupon.type === 'percentage') {
        discount = (originalPrice * coupon.value) / 100;
    } else {
        discount = coupon.value;
    }
    
    // Impede desconto maior que o preço
    return Math.min(discount, originalPrice);
}

/**
 * Incrementa o uso de um cupom
 */
function incrementCouponUse(couponId) {
    run("UPDATE coupons SET current_uses = current_uses + 1 WHERE id = ?", [couponId]);
}

module.exports = {
    createCoupon,
    validateCoupon,
    calculateDiscount,
    incrementCouponUse
};
