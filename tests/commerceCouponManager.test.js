const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commerceCouponManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get } = require('../src/database/database');
initDatabase();

const CouponManager = require('../src/managers/commerce/CouponManager');

function makeCoupon({ code, type = 'fixed', value = 10, maxUses = 0, expiresAt = null, status = 'active' }) {
    run('INSERT INTO coupons (code, type, value, max_uses, expires_at, status) VALUES (?, ?, ?, ?, ?, ?)', [code, type, value, maxUses, expiresAt, status]);
    return get('SELECT * FROM coupons WHERE code = ?', [code]);
}

test('validateCoupon: encontra por código, case-insensitive', () => {
    makeCoupon({ code: 'PROMO10' });
    const found = CouponManager.validateCoupon('promo10');
    assert.equal(found.code, 'PROMO10');
});

test('validateCoupon: lança para código inexistente', () => {
    assert.throws(() => CouponManager.validateCoupon('NUNCA-EXISTIU'), /não encontrado/);
});

test('validateCoupon: lança para cupom inativo', () => {
    makeCoupon({ code: 'INATIVO', status: 'inactive' });
    assert.throws(() => CouponManager.validateCoupon('INATIVO'), /inativo/);
});

test('validateCoupon: lança para cupom expirado', () => {
    makeCoupon({ code: 'VENCIDO', expiresAt: '2000-01-01' });
    assert.throws(() => CouponManager.validateCoupon('VENCIDO'), /expirou/);
});

test('validateCoupon: lança quando já atingiu max_uses', () => {
    run('INSERT INTO coupons (code, type, value, max_uses, current_uses) VALUES (?, ?, ?, ?, ?)', ['ESGOTADO', 'fixed', 5, 3, 3]);
    assert.throws(() => CouponManager.validateCoupon('ESGOTADO'), /limite máximo/);
});

test('calculateDiscount: percentual', () => {
    const coupon = { type: 'percentage', value: 25 };
    assert.equal(CouponManager.calculateDiscount(coupon, 200), 50);
});

test('calculateDiscount: fixo', () => {
    const coupon = { type: 'fixed', value: 30 };
    assert.equal(CouponManager.calculateDiscount(coupon, 200), 30);
});

test('calculateDiscount: nunca excede o preço original', () => {
    const coupon = { type: 'fixed', value: 999 };
    assert.equal(CouponManager.calculateDiscount(coupon, 50), 50);
});

test('confirmUsage: incrementa current_uses', () => {
    const coupon = makeCoupon({ code: 'CONFIRM1', maxUses: 5 });
    CouponManager.confirmUsage(coupon.id);
    const updated = get('SELECT * FROM coupons WHERE id = ?', [coupon.id]);
    assert.equal(updated.current_uses, 1);
});

test('confirmUsage: RACE DE ESTOQUE — revalida o limite NO MOMENTO da confirmação, avisa mas não bloqueia (pagamento já foi confirmado por um humano)', () => {
    // Simula o cenário do bug já corrigido uma vez no legado: vários
    // pedidos aplicaram o mesmo cupom de uso único ANTES de qualquer
    // aprovação; agora todos chegam pra confirmação.
    const coupon = makeCoupon({ code: 'UNICO', maxUses: 1 });

    const r1 = CouponManager.confirmUsage(coupon.id);
    assert.equal(r1.overLimit, false); // primeiro uso, dentro do limite

    const r2 = CouponManager.confirmUsage(coupon.id);
    assert.equal(r2.overLimit, true); // segundo uso, já estourou — mas não lança

    const finalState = get('SELECT * FROM coupons WHERE id = ?', [coupon.id]);
    assert.equal(finalState.current_uses, 2); // ambos foram de fato confirmados (decisão humana já tomada)
});

test('confirmUsage: lança para cupom inexistente', () => {
    assert.throws(() => CouponManager.confirmUsage(999999), /não encontrado/);
});
