/**
 * GERENCIADOR DE AFILIADOS
 * Gerencia códigos de indicação, saldo e comissões.
 */
const { get, run, query } = require('../database/database');
const { generateId } = require('../utils/codeGenerator');

/**
 * Gera um código de afiliado único para o usuário
 */
function getOrCreateAffiliateCode(userId) {
    const user = get("SELECT affiliate_code FROM users WHERE id = ?", [userId]);
    if (user && user.affiliate_code) return user.affiliate_code;

    const code = generateId(6).toUpperCase();
    run("UPDATE users SET affiliate_code = ? WHERE id = ?", [code, userId]);
    return code;
}

/**
 * Vincula um usuário a um padrinho (referral)
 */
function setReferral(userId, code) {
    const referrer = get("SELECT id FROM users WHERE affiliate_code = ?", [code.toUpperCase()]);
    if (!referrer) throw new Error('Código de indicação inválido.');
    if (referrer.id === userId) throw new Error('Você não pode indicar a si mesmo.');

    const user = get("SELECT referred_by FROM users WHERE id = ?", [userId]);
    if (user && user.referred_by) throw new Error('Você já foi indicado por outro usuário.');

    run("UPDATE users SET referred_by = ? WHERE id = ?", [referrer.id, userId]);
    return referrer.id;
}

/**
 * Processa comissão de uma venda aprovada
 */
function processSaleCommission(order) {
    const user = get("SELECT referred_by FROM users WHERE id = ?", [order.user_id]);
    if (!user || !user.referred_by) return;

    const config = get("SELECT affiliate_commission FROM sales_config WHERE id = 1");
    const commission = (order.total_price * (config.affiliate_commission || 10)) / 100;

    run("UPDATE users SET balance = balance + ? WHERE id = ?", [commission, user.referred_by]);
    
    const { logAction } = require('./logManager');
    logAction(null, user.referred_by, 'AFFILIATE_COMMISSION', `Recebeu R$ ${commission.toFixed(2)} de comissão da compra do usuário ${order.user_id}`);
}

/**
 * Obtém estatísticas de afiliado do usuário
 */
function getAffiliateStats(userId) {
    const user = get("SELECT balance, affiliate_code FROM users WHERE id = ?", [userId]);
    const referrals = get("SELECT COUNT(*) as count FROM users WHERE referred_by = ?", [userId]).count;
    
    return {
        balance: user.balance || 0,
        code: user.affiliate_code,
        referrals
    };
}

module.exports = {
    getOrCreateAffiliateCode,
    setReferral,
    processSaleCommission,
    getAffiliateStats
};
