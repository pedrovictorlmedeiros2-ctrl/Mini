const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commerceScheduler.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get } = require('../src/database/database');
initDatabase();

const config = require('../config');
config.commerce.cartExpirationHours = 2;

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const EntitlementManager = require('../src/managers/commerce/EntitlementManager');
const CommerceScheduler = require('../src/managers/commerce/CommerceScheduler');

let counter = 0;
function makeUser() {
    counter += 1;
    const userId = `schedtest-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    return userId;
}
function makeProduct(overrides = {}) {
    counter += 1;
    const product = ProductCatalog.saveProduct({ id: `schedtest-prod-${counter}`, name: 'Plano', price: 10, maxBots: 1, maxRam: 256, maxCpu: 30, ...overrides });
    return ProductCatalog.publishProduct(product.id);
}

test('sweepExpiredCarts: expira AWAITING_PAYMENT parado há mais de cartExpirationHours', () => {
    const userId = makeUser();
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `schedtest-old-${counter}` });
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    // Simula "parado há 3 horas" — além do limite de 2h configurado.
    run("UPDATE commerce_orders SET updated_at = datetime('now', '-3 hours') WHERE id = ?", [order.id]);

    const expiredCount = CommerceScheduler.sweepExpiredCarts();
    assert.ok(expiredCount >= 1);
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.EXPIRED);
});

test('sweepExpiredCarts: NUNCA expira um carrinho dentro do prazo (só 1h de idade, limite é 2h)', () => {
    const userId = makeUser();
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `schedtest-fresh-${counter}` });
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    run("UPDATE commerce_orders SET updated_at = datetime('now', '-1 hours') WHERE id = ?", [order.id]);

    CommerceScheduler.sweepExpiredCarts();
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.AWAITING_PAYMENT);
});

test('sweepExpiredCarts: nunca toca em pedidos em outros estados (DRAFT, UNDER_REVIEW, etc.)', () => {
    const userId = makeUser();
    const draftOrder = OrderManager.createOrder({ userId, channelId: `schedtest-draft-${counter += 1}` });
    run("UPDATE commerce_orders SET updated_at = datetime('now', '-100 hours') WHERE id = ?", [draftOrder.id]);

    CommerceScheduler.sweepExpiredCarts();
    assert.equal(OrderManager.getOrder(draftOrder.id).status, OrderManager.STATUS.DRAFT);
});

test('sweepExpiredCarts: prazo é configurável via config.commerce.cartExpirationHours', () => {
    const originalHours = config.commerce.cartExpirationHours;
    config.commerce.cartExpirationHours = 0.01; // ~36 segundos, pra expirar quase tudo
    try {
        const userId = makeUser();
        counter += 1;
        const order = OrderManager.createOrder({ userId, channelId: `schedtest-configurable-${counter}` });
        const product = makeProduct();
        OrderManager.confirmProduct(order.id, product.id);
        run("UPDATE commerce_orders SET updated_at = datetime('now', '-1 hours') WHERE id = ?", [order.id]);

        CommerceScheduler.sweepExpiredCarts();
        assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.EXPIRED);
    } finally {
        config.commerce.cartExpirationHours = originalHours;
    }
});

test('sweepExpiredEntitlements: expira entitlements ativos com expires_at no passado', () => {
    const userId = makeUser();
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `schedtest-ent-${counter}` });
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [OrderManager.STATUS.PROVISIONING, order.id]);
    const entitlement = EntitlementManager.grant(order.id);
    run("UPDATE commerce_entitlements SET expires_at = datetime('now', '-1 day') WHERE id = ?", [entitlement.id]);

    const count = CommerceScheduler.sweepExpiredEntitlements();
    assert.ok(count >= 1);
    assert.equal(EntitlementManager.getEntitlement(entitlement.id).status, 'expired');
});

test('sweepExpiredEntitlements: nunca toca em entitlement ainda dentro da validade', () => {
    const userId = makeUser();
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `schedtest-ent-valid-${counter}` });
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [OrderManager.STATUS.PROVISIONING, order.id]);
    const entitlement = EntitlementManager.grant(order.id);

    CommerceScheduler.sweepExpiredEntitlements();
    assert.equal(EntitlementManager.getEntitlement(entitlement.id).status, 'active');
});

test('reconcileStuckProvisioning: pedido preso em PROVISIONING (processo caiu no meio) vira PROVISIONING_FAILED — nunca resume às cegas', () => {
    const userId = makeUser();
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `schedtest-stuck-${counter}` });
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [OrderManager.STATUS.PROVISIONING, order.id]);

    const count = CommerceScheduler.reconcileStuckProvisioning();
    assert.ok(count >= 1);
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.PROVISIONING_FAILED);
});

test('reconcileStuckProvisioning: nunca toca em pedidos que não estão presos em PROVISIONING', () => {
    const userId = makeUser();
    const order = OrderManager.createOrder({ userId, channelId: `schedtest-notstuck-${counter += 1}` });

    CommerceScheduler.reconcileStuckProvisioning();
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.DRAFT);
});

test('start/stop: liga e desliga o timer sem lançar, idempotente', () => {
    assert.doesNotThrow(() => CommerceScheduler.startCommerceScheduler());
    assert.doesNotThrow(() => CommerceScheduler.startCommerceScheduler());
    assert.doesNotThrow(() => CommerceScheduler.stopCommerceScheduler());
    assert.doesNotThrow(() => CommerceScheduler.stopCommerceScheduler());
});
