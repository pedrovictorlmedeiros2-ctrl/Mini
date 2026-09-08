const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commercePaymentManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get, query } = require('../src/database/database');
initDatabase();

run("UPDATE sales_config SET pix_key = 'pix-key-test@example.com', pix_name = 'Atlantic Host Teste', pix_city = 'São Paulo' WHERE id = 1");

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const CommerceStaffManager = require('../src/managers/commerce/CommerceStaffManager');
const PaymentManager = require('../src/managers/commerce/PaymentManager');

let counter = 0;
function makeUser(role = 'client') {
    counter += 1;
    const userId = `pmtest-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', role]);
    return userId;
}
function makeOrderReadyForReview(userId, priceOverride) {
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `pmtest-channel-${counter}` });
    const product = ProductCatalog.saveProduct({
        id: `pmtest-prod-${counter}`, name: 'Plano Teste', price: priceOverride ?? 49.9,
        maxBots: 2, maxRam: 512, maxCpu: 40,
    });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    OrderManager.transitionOrder(order.id, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.PROOF_SUBMITTED);
    return OrderManager.getOrder(order.id);
}

test('createPaymentRecord: snapshota os dados Pix de sales_config no momento da criação', () => {
    const userId = makeUser();
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `pmtest-snap-${counter}` });
    const product = ProductCatalog.saveProduct({ id: `pmtest-snap-prod-${counter}`, name: 'X', price: 10, maxBots: 1, maxRam: 256, maxCpu: 30 });
    OrderManager.confirmProduct(order.id, product.id);

    const payment = PaymentManager.createPaymentRecord(order.id);
    assert.equal(payment.pix_key_snapshot, 'pix-key-test@example.com');
    assert.equal(payment.expected_amount, 10);
    assert.equal(payment.status, 'awaiting_proof');

    // Mudar a chave Pix global DEPOIS não deveria afetar o snapshot já gravado.
    run("UPDATE sales_config SET pix_key = 'outra-chave-nova@example.com' WHERE id = 1");
    const reread = PaymentManager.getPaymentByOrder(order.id);
    assert.equal(reread.pix_key_snapshot, 'pix-key-test@example.com', 'snapshot Pix nunca deveria mudar com uma edição posterior de sales_config');

    run("UPDATE sales_config SET pix_key = 'pix-key-test@example.com' WHERE id = 1"); // restaura pros próximos testes
});

test('createPaymentRecord: idempotente — chamar duas vezes não duplica', () => {
    const userId = makeUser();
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `pmtest-idem-${counter}` });
    const product = ProductCatalog.saveProduct({ id: `pmtest-idem-prod-${counter}`, name: 'X', price: 10, maxBots: 1, maxRam: 256, maxCpu: 30 });
    OrderManager.confirmProduct(order.id, product.id);

    PaymentManager.createPaymentRecord(order.id);
    PaymentManager.createPaymentRecord(order.id);
    const rows = query('SELECT * FROM commerce_payments WHERE order_id = ?', [order.id]);
    assert.equal(rows.length, 1);
});

test('openForReview: PROOF_SUBMITTED -> UNDER_REVIEW, exige permissão comercial', () => {
    const admin = makeUser('admin');
    const client = makeUser('client');
    const order = makeOrderReadyForReview(client);

    assert.throws(() => PaymentManager.openForReview(order.id, client), /sem permissão/);
    const opened = PaymentManager.openForReview(order.id, admin);
    assert.equal(opened.status, OrderManager.STATUS.UNDER_REVIEW);
});

test('confirmPayment: leva o pedido a APPROVED — NUNCA a ACTIVE/PROVISIONING (invariante #1 desta fase)', () => {
    const admin = makeUser('admin');
    const client = makeUser('client');
    const order = makeOrderReadyForReview(client);
    PaymentManager.openForReview(order.id, admin);

    const { order: approved } = PaymentManager.confirmPayment(order.id, admin);
    assert.equal(approved.status, OrderManager.STATUS.APPROVED);
    assert.notEqual(approved.status, OrderManager.STATUS.ACTIVE);

    const payment = PaymentManager.getPaymentByOrder(order.id);
    assert.equal(payment.status, 'confirmed');
    assert.equal(payment.confirmed_by_admin_id, admin);
});

test('confirmPayment: exige permissão comercial — checada DENTRO do manager, nunca só na UI', () => {
    const admin = makeUser('admin');
    const client = makeUser('client');
    const order = makeOrderReadyForReview(client);
    PaymentManager.openForReview(order.id, admin);

    assert.throws(() => PaymentManager.confirmPayment(order.id, client), /sem permissão/);
    // Confirma que a tentativa negada REALMENTE não mudou nada.
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.UNDER_REVIEW);
});

test('confirmPayment: COMMERCE_STAFF (sem ser admin) também pode aprovar', () => {
    const admin = makeUser('admin');
    const staff = makeUser('client');
    CommerceStaffManager.grant(staff, admin);
    const client = makeUser('client');
    const order = makeOrderReadyForReview(client);
    PaymentManager.openForReview(order.id, staff);

    const { order: approved } = PaymentManager.confirmPayment(order.id, staff);
    assert.equal(approved.status, OrderManager.STATUS.APPROVED);
});

test('confirmPayment: incrementa o uso do cupom SÓ na confirmação, nunca antes', () => {
    const admin = makeUser('admin');
    const client = makeUser('client');
    const order = makeOrderReadyForReview(client);

    const couponResult = run("INSERT INTO coupons (code, type, value, max_uses) VALUES ('PMTEST', 'fixed', 5, 10)");
    const couponId = couponResult.lastInsertRowid;
    run('UPDATE commerce_orders SET coupon_id = ? WHERE id = ?', [couponId, order.id]);

    let coupon = get('SELECT * FROM coupons WHERE id = ?', [couponId]);
    assert.equal(coupon.current_uses, 0);

    PaymentManager.openForReview(order.id, admin);
    PaymentManager.confirmPayment(order.id, admin);

    coupon = get('SELECT * FROM coupons WHERE id = ?', [couponId]);
    assert.equal(coupon.current_uses, 1);
});

test('rejectPayment: motivo obrigatório, leva a REJECTED', () => {
    const admin = makeUser('admin');
    const client = makeUser('client');
    const order = makeOrderReadyForReview(client);
    PaymentManager.openForReview(order.id, admin);

    assert.throws(() => PaymentManager.rejectPayment(order.id, admin, ''), /obrigatório/);

    const rejected = PaymentManager.rejectPayment(order.id, admin, 'comprovante ilegível');
    assert.equal(rejected.status, OrderManager.STATUS.REJECTED);
    assert.equal(rejected.rejection_reason, 'comprovante ilegível');

    const payment = PaymentManager.getPaymentByOrder(order.id);
    assert.equal(payment.status, 'rejected');
});

test('DUPLA APROVAÇÃO: confirmar duas vezes o mesmo pedido — só a primeira funciona (CAS herdado do OrderManager)', () => {
    const admin = makeUser('admin');
    const client = makeUser('client');
    const order = makeOrderReadyForReview(client);
    PaymentManager.openForReview(order.id, admin);

    PaymentManager.confirmPayment(order.id, admin);
    assert.throws(() => PaymentManager.confirmPayment(order.id, admin), /não está em revisão/);
});
