const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commerceOrderManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, query } = require('../src/database/database');
initDatabase();

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');

let counter = 0;
function makeUser() {
    counter += 1;
    const userId = `omtest-user-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    return userId;
}
function makeProduct(overrides = {}) {
    counter += 1;
    return ProductCatalog.saveProduct({
        id: `omtest-prod-${counter}`,
        name: `Plano ${counter}`,
        price: 39.9,
        maxBots: 3,
        maxRam: 512,
        maxCpu: 40,
        ...overrides,
    });
}
function makeOrder(userId) {
    counter += 1;
    return OrderManager.createOrder({ userId, channelId: `omtest-channel-${counter}` });
}

test('createOrder: sempre nasce em DRAFT, sem produto', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    assert.equal(order.status, OrderManager.STATUS.DRAFT);
    assert.equal(order.product_id, null);
});

test('createOrder: exige userId e channelId', () => {
    assert.throws(() => OrderManager.createOrder({ channelId: 'x' }));
    assert.throws(() => OrderManager.createOrder({ userId: 'x' }));
});

test('confirmProduct: DRAFT -> AWAITING_PAYMENT, grava snapshot e preço derivado do produto (nunca aceita preço de fora)', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    const product = makeProduct({ price: 59.9 });

    const updated = OrderManager.confirmProduct(order.id, product.id);
    assert.equal(updated.status, OrderManager.STATUS.AWAITING_PAYMENT);
    assert.equal(updated.original_price, 59.9);
    assert.equal(updated.total_price, 59.9);
    assert.ok(updated.product_snapshot);
    const snapshot = JSON.parse(updated.product_snapshot);
    assert.equal(snapshot.price, 59.9);
});

test('confirmProduct: nunca aceita um preço como parâmetro — a assinatura da função nem tem esse parâmetro', () => {
    // .length não conta parâmetros com valor default (renewalOfEntitlementId=null)
    // — a assinatura real é (orderId, productId, renewalOfEntitlementId), sem
    // nenhum parâmetro de preço/valor em lugar nenhum.
    assert.equal(OrderManager.confirmProduct.length, 2);
    const signature = OrderManager.confirmProduct.toString().split('{')[0];
    assert.equal(/price|amount|valor/i.test(signature), false, `assinatura não deveria ter parâmetro de preço: ${signature}`);
});

test('confirmProduct: só funciona a partir de DRAFT — falha se chamado duas vezes', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    assert.throws(() => OrderManager.confirmProduct(order.id, product.id), /não está em DRAFT/);
});

test('transitionOrder: transição fora da máquina de estados lança (erro de programação, não corrida perdida)', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    assert.throws(() => OrderManager.transitionOrder(order.id, [OrderManager.STATUS.DRAFT], OrderManager.STATUS.ACTIVE), /não é válida/);
});

test('transitionOrder: corrida perdida retorna null, nunca lança', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    // Pedido está em DRAFT — tentar transicionar como se estivesse em UNDER_REVIEW nunca deveria "achar" o pedido.
    const result = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.UNDER_REVIEW], OrderManager.STATUS.APPROVED);
    assert.equal(result, null);
});

test('CONCORRÊNCIA: duas transições disputando o mesmo pedido — só uma vence (CAS)', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [OrderManager.STATUS.UNDER_REVIEW, order.id]);

    const winner = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.UNDER_REVIEW], OrderManager.STATUS.APPROVED);
    const loser = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.UNDER_REVIEW], OrderManager.STATUS.APPROVED);

    assert.ok(winner);
    assert.equal(loser, null);
});

test('applyCoupon/removeCoupon: recalcula total a partir de original_price (snapshot), nunca do preço "ao vivo"', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    const product = makeProduct({ price: 100 });
    OrderManager.confirmProduct(order.id, product.id);

    const couponResult = run("INSERT INTO coupons (code, type, value) VALUES ('OM-TEST', 'fixed', 20)");
    const couponId = couponResult.lastInsertRowid;

    const withCoupon = OrderManager.applyCoupon(order.id, couponId, 20);
    assert.equal(withCoupon.discount_amount, 20);
    assert.equal(withCoupon.total_price, 80);
    assert.equal(withCoupon.coupon_id, couponId);

    const withoutCoupon = OrderManager.removeCoupon(order.id);
    assert.equal(withoutCoupon.discount_amount, 0);
    assert.equal(withoutCoupon.total_price, 100);
    assert.equal(withoutCoupon.coupon_id, null);
});

test('applyCoupon: só funciona em AWAITING_PAYMENT', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    assert.throws(() => OrderManager.applyCoupon(order.id, 1, 10), /não está aguardando pagamento/);
});

test('cancelOrder: permitido em DRAFT/AWAITING_PAYMENT/PROOF_SUBMITTED', () => {
    const userId = makeUser();
    const order1 = makeOrder(userId);
    const cancelled1 = OrderManager.cancelOrder(order1.id);
    assert.equal(cancelled1.status, OrderManager.STATUS.CANCELLED);

    const order2 = makeOrder(userId);
    const product = makeProduct();
    OrderManager.confirmProduct(order2.id, product.id);
    const cancelled2 = OrderManager.cancelOrder(order2.id);
    assert.equal(cancelled2.status, OrderManager.STATUS.CANCELLED);
});

test('cancelOrder: nunca permitido a partir de UNDER_REVIEW em diante (só o staff decide dali pra frente)', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [OrderManager.STATUS.UNDER_REVIEW, order.id]);

    assert.throws(() => OrderManager.cancelOrder(order.id), /não pode mais ser cancelado/);
});

test('MÁQUINA DE ESTADOS COMPLETA: DRAFT -> ... -> ACTIVE percorrendo cada transição válida', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    const product = makeProduct();

    OrderManager.confirmProduct(order.id, product.id);
    let o = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.PROOF_SUBMITTED);
    assert.ok(o);
    o = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.PROOF_SUBMITTED], OrderManager.STATUS.UNDER_REVIEW);
    assert.ok(o);
    o = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.UNDER_REVIEW], OrderManager.STATUS.APPROVED);
    assert.ok(o);
    o = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.APPROVED], OrderManager.STATUS.PROVISIONING);
    assert.ok(o);
    o = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.PROVISIONING], OrderManager.STATUS.ACTIVE);
    assert.equal(o.status, OrderManager.STATUS.ACTIVE);
});

test('PROVISIONING_FAILED -> PROVISIONING: retry permitido (não-terminal)', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [OrderManager.STATUS.PROVISIONING, order.id]);
    let o = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.PROVISIONING], OrderManager.STATUS.PROVISIONING_FAILED);
    assert.ok(o);
    o = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.PROVISIONING_FAILED], OrderManager.STATUS.PROVISIONING);
    assert.equal(o.status, OrderManager.STATUS.PROVISIONING);
});

test('REJECTED: motivo é gravado via extraFields do CAS', () => {
    const userId = makeUser();
    const order = makeOrder(userId);
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [OrderManager.STATUS.UNDER_REVIEW, order.id]);

    const rejected = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.UNDER_REVIEW], OrderManager.STATUS.REJECTED, { rejection_reason: 'comprovante inválido' });
    assert.equal(rejected.rejection_reason, 'comprovante inválido');
});
