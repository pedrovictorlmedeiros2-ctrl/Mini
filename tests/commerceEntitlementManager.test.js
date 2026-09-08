const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commerceEntitlementManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get } = require('../src/database/database');
initDatabase();

const config = require('../config');

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const EntitlementManager = require('../src/managers/commerce/EntitlementManager');

let counter = 0;
function makeUser() {
    counter += 1;
    const userId = `emtest-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    return userId;
}
function makeProduct(overrides = {}) {
    counter += 1;
    const product = ProductCatalog.saveProduct({
        id: `emtest-prod-${counter}`, name: 'Plano', price: 39.9,
        maxBots: 3, maxRam: 512, maxCpu: 40, ...overrides,
    });
    return ProductCatalog.publishProduct(product.id);
}
/** Cria um pedido e o leva até PROVISIONING — ponto onde grant() pode ser chamado. */
function makeOrderInProvisioning(userId, { productOverrides = {}, renewalOfEntitlementId = null } = {}) {
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `emtest-channel-${counter}` });
    const product = makeProduct(productOverrides);
    OrderManager.confirmProduct(order.id, product.id, renewalOfEntitlementId);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [OrderManager.STATUS.PROOF_SUBMITTED, order.id]);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [OrderManager.STATUS.UNDER_REVIEW, order.id]);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [OrderManager.STATUS.APPROVED, order.id]);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [OrderManager.STATUS.PROVISIONING, order.id]);
    return OrderManager.getOrder(order.id);
}

test('grant: só funciona a partir de PROVISIONING — nunca antes (invariante: pagamento confirmado != ACTIVE)', () => {
    const userId = makeUser();
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `emtest-early-${counter}` });
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    // Ainda em AWAITING_PAYMENT — nunca deveria conseguir conceder daqui.
    assert.throws(() => EntitlementManager.grant(order.id), /não está em PROVISIONING/);
});

test('grant: cria o entitlement com activated_at=agora quando não é renovação', () => {
    const userId = makeUser();
    const order = makeOrderInProvisioning(userId);
    const before = Date.now();
    const entitlement = EntitlementManager.grant(order.id);
    const after = Date.now();

    assert.equal(entitlement.status, 'active');
    const activatedAtMs = new Date(entitlement.activated_at.replace(' ', 'T') + 'Z').getTime();
    assert.ok(activatedAtMs >= before - 2000 && activatedAtMs <= after + 2000, 'activated_at deveria ser aproximadamente agora');
});

test('grant: expires_at é activated_at + 1 mês (billing_period mensal)', () => {
    const userId = makeUser();
    const order = makeOrderInProvisioning(userId);
    const entitlement = EntitlementManager.grant(order.id);

    const activated = new Date(entitlement.activated_at.replace(' ', 'T') + 'Z');
    const expires = new Date(entitlement.expires_at.replace(' ', 'T') + 'Z');
    const expectedMonth = (activated.getUTCMonth() + 1) % 12;
    assert.equal(expires.getUTCMonth(), expectedMonth);
});

test('grant: idempotente — chamar duas vezes pro mesmo pedido retorna o mesmo entitlement, nunca cria um segundo', () => {
    const userId = makeUser();
    const order = makeOrderInProvisioning(userId);
    const first = EntitlementManager.grant(order.id);
    const second = EntitlementManager.grant(order.id);
    assert.equal(first.id, second.id);
});

test('grant: recomputa a capacidade do usuário (users.max_bots/max_ram/max_cpu) a partir do snapshot do pedido', () => {
    // Valores deliberadamente ABAIXO dos tetos de host default (512MB
    // RAM / 50% CPU / 10 bots) — este teste verifica que a capacidade
    // reflete o snapshot do produto; o teto de host é testado à parte
    // no próximo teste.
    const userId = makeUser();
    const order = makeOrderInProvisioning(userId, { productOverrides: { maxBots: 5, maxRam: 400, maxCpu: 35 } });
    EntitlementManager.grant(order.id);

    const user = get('SELECT * FROM users WHERE id = ?', [userId]);
    assert.equal(user.max_bots, 5);
    assert.equal(user.max_ram, 400);
    assert.equal(user.max_cpu, 35);
});

test('grant: nunca concede mais do que o teto de segurança do host (HOST_MAX_*), mesmo que o produto peça mais', () => {
    const originalRamCap = process.env.HOST_MAX_RAM_PER_BOT;
    process.env.HOST_MAX_RAM_PER_BOT = '512';
    try {
        const userId = makeUser();
        const order = makeOrderInProvisioning(userId, { productOverrides: { maxRam: 999999 } });
        EntitlementManager.grant(order.id);
        const user = get('SELECT * FROM users WHERE id = ?', [userId]);
        assert.equal(user.max_ram, 512);
    } finally {
        if (originalRamCap === undefined) delete process.env.HOST_MAX_RAM_PER_BOT;
        else process.env.HOST_MAX_RAM_PER_BOT = originalRamCap;
    }
});

test('INVARIANTE: não acumula múltiplos entitlements simultâneos — segunda compra (não-renovação) enquanto já tem um ativo é recusada', () => {
    const userId = makeUser();
    const order1 = makeOrderInProvisioning(userId);
    EntitlementManager.grant(order1.id);

    const order2 = makeOrderInProvisioning(userId); // pedido novo, SEM renewal_of_entitlement_id
    assert.throws(() => EntitlementManager.grant(order2.id), EntitlementManager.EntitlementConflictError);

    // Confirma que a tentativa recusada não criou nada nem bagunçou o estado.
    assert.equal(EntitlementManager.getEntitlementByOrder(order2.id), undefined);
    const active = EntitlementManager.getActiveEntitlement(userId);
    assert.equal(active.order_id, order1.id);
});

test('getActiveEntitlement: nunca retorna mais de um — violação de integridade lança explicitamente se acontecer', () => {
    const userId = makeUser();
    const order1 = makeOrderInProvisioning(userId);
    const e1 = EntitlementManager.grant(order1.id);

    // Simula uma violação de integridade (escrita direta, por fora do
    // manager) só pra provar que getActiveEntitlement() DETECTA isso em
    // vez de silenciosamente devolver qualquer um dos dois.
    counter += 1;
    const order2 = OrderManager.createOrder({ userId: makeUser(), channelId: `emtest-integrity-${counter}` });
    run('UPDATE commerce_orders SET user_id = ? WHERE id = ?', [userId, order2.id]);
    run('INSERT INTO commerce_entitlements (order_id, user_id, status, activated_at, expires_at) VALUES (?, ?, ?, datetime(\'now\'), datetime(\'now\', \'+1 month\'))', [order2.id, userId, 'active']);

    assert.throws(() => EntitlementManager.getActiveEntitlement(userId), /Violação de integridade/);
});

test('RENOVAÇÃO — DECISÃO #1: activated_at = max(agora, expires_at do entitlement anterior) — renovação ANTECIPADA não perde dias pagos', () => {
    const userId = makeUser();
    const order1 = makeOrderInProvisioning(userId);
    const original = EntitlementManager.grant(order1.id);

    // Renova IMEDIATAMENTE (o entitlement original ainda tem quase um mês
    // inteiro de vigência restante).
    const order2 = makeOrderInProvisioning(userId, { renewalOfEntitlementId: original.id });
    const renewed = EntitlementManager.grant(order2.id);

    // activated_at do renovado deveria ser igual ao expires_at do original
    // (dentro de uma pequena margem de arredondamento de segundo), NUNCA
    // "agora" (que perderia os dias restantes pagos).
    const originalExpiresMs = new Date(original.expires_at.replace(' ', 'T') + 'Z').getTime();
    const renewedActivatedMs = new Date(renewed.activated_at.replace(' ', 'T') + 'Z').getTime();
    assert.ok(Math.abs(renewedActivatedMs - originalExpiresMs) < 2000, `activated_at do renovado (${renewed.activated_at}) deveria ser ~= expires_at do original (${original.expires_at})`);
});

test('RENOVAÇÃO — DECISÃO #1: renovação DEPOIS de expirado começa imediatamente (max() resolve pro "agora")', () => {
    const userId = makeUser();
    const order1 = makeOrderInProvisioning(userId);
    const original = EntitlementManager.grant(order1.id);

    // Simula que o entitlement original já expirou há dias (força
    // expires_at pro passado, como se o CommerceScheduler ainda não
    // tivesse rodado a varredura, ou já tivesse marcado 'expired').
    run("UPDATE commerce_entitlements SET expires_at = datetime('now', '-5 days') WHERE id = ?", [original.id]);

    const before = Date.now();
    const order2 = makeOrderInProvisioning(userId, { renewalOfEntitlementId: original.id });
    const renewed = EntitlementManager.grant(order2.id);
    const after = Date.now();

    const renewedActivatedMs = new Date(renewed.activated_at.replace(' ', 'T') + 'Z').getTime();
    assert.ok(renewedActivatedMs >= before - 2000 && renewedActivatedMs <= after + 2000, 'renovação após expiração deveria começar imediatamente (agora), não na data de expiração passada');
});

test('RENOVAÇÃO: fecha (status=expired) o entitlement anterior no mesmo instante em que cria o novo — nunca dois "active" simultâneos', () => {
    const userId = makeUser();
    const order1 = makeOrderInProvisioning(userId);
    const original = EntitlementManager.grant(order1.id);
    assert.equal(EntitlementManager.getEntitlement(original.id).status, 'active');

    const order2 = makeOrderInProvisioning(userId, { renewalOfEntitlementId: original.id });
    EntitlementManager.grant(order2.id);

    assert.equal(EntitlementManager.getEntitlement(original.id).status, 'expired');
    const active = EntitlementManager.getActiveEntitlement(userId);
    assert.equal(active.order_id, order2.id);
});

test('RENOVAÇÃO: encadeamento de várias renovações seguidas preserva o histórico completo (nunca edita uma linha antiga)', () => {
    const userId = makeUser();
    const order1 = makeOrderInProvisioning(userId);
    const e1 = EntitlementManager.grant(order1.id);

    const order2 = makeOrderInProvisioning(userId, { renewalOfEntitlementId: e1.id });
    const e2 = EntitlementManager.grant(order2.id);

    const order3 = makeOrderInProvisioning(userId, { renewalOfEntitlementId: e2.id });
    const e3 = EntitlementManager.grant(order3.id);

    assert.notEqual(e1.id, e2.id);
    assert.notEqual(e2.id, e3.id);
    assert.equal(EntitlementManager.getEntitlement(e1.id).status, 'expired');
    assert.equal(EntitlementManager.getEntitlement(e2.id).status, 'expired');
    assert.equal(EntitlementManager.getEntitlement(e3.id).status, 'active');
    // As linhas antigas continuam existindo e legíveis — nunca apagadas.
    assert.ok(EntitlementManager.getEntitlement(e1.id));
});

test('RENOVAÇÃO: referenciar um entitlement que NÃO é o do usuário nunca é aceito', () => {
    const userId = makeUser();
    const otherUserId = makeUser();
    const orderOther = makeOrderInProvisioning(otherUserId);
    const otherEntitlement = EntitlementManager.grant(orderOther.id);

    const order = makeOrderInProvisioning(userId, { renewalOfEntitlementId: otherEntitlement.id });
    assert.throws(() => EntitlementManager.grant(order.id), /não pertence ao usuário/);
});

test('RENOVAÇÃO: renovar um entitlement diferente do ativo atual do usuário é recusado (conflito)', () => {
    const userId = makeUser();
    const orderA = makeOrderInProvisioning(userId);
    const entitlementA = EntitlementManager.grant(orderA.id);

    // Usuário de alguma forma tem um entitlement "solto" mais antigo (não é
    // o atual) e tenta renová-lo em vez do atual — deveria ser recusado.
    const orderOld = makeOrderInProvisioning(makeUser());
    const oldEntitlement = EntitlementManager.grant(orderOld.id);
    run('UPDATE commerce_entitlements SET user_id = ?, status = ? WHERE id = ?', [userId, 'expired', oldEntitlement.id]);

    const orderRenewOld = makeOrderInProvisioning(userId, { renewalOfEntitlementId: oldEntitlement.id });
    assert.throws(() => EntitlementManager.grant(orderRenewOld.id), EntitlementManager.EntitlementConflictError);
});

test('RENOVAÇÃO: nunca permitida sobre um entitlement revogado', () => {
    const userId = makeUser();
    const order1 = makeOrderInProvisioning(userId);
    const entitlement = EntitlementManager.grant(order1.id);
    EntitlementManager.revokeEntitlement(entitlement.id, 'admin-x', 'chargeback');

    const order2 = makeOrderInProvisioning(userId, { renewalOfEntitlementId: entitlement.id });
    assert.throws(() => EntitlementManager.grant(order2.id), /revogado administrativamente/);
});

test('expireEntitlement: idempotente, recomputa capacidade pro default quando não há mais nada ativo', () => {
    const userId = makeUser();
    const order = makeOrderInProvisioning(userId, { productOverrides: { maxBots: 9, maxRam: 900, maxCpu: 70 } });
    const entitlement = EntitlementManager.grant(order.id);

    let user = get('SELECT * FROM users WHERE id = ?', [userId]);
    assert.equal(user.max_bots, 9);

    EntitlementManager.expireEntitlement(entitlement.id);
    assert.doesNotThrow(() => EntitlementManager.expireEntitlement(entitlement.id)); // idempotente

    user = get('SELECT * FROM users WHERE id = ?', [userId]);
    assert.equal(user.max_bots, config.security.maxBotsPerUser);
    assert.equal(user.max_ram, config.security.maxRamPerBot);
    assert.equal(user.max_cpu, config.security.maxCpuPerBot);
});

test('revokeEntitlement: idempotente, sempre auditável (motivo registrado)', () => {
    const userId = makeUser();
    const order = makeOrderInProvisioning(userId);
    const entitlement = EntitlementManager.grant(order.id);

    const revoked = EntitlementManager.revokeEntitlement(entitlement.id, 'admin-y', 'fraude suspeita');
    assert.equal(revoked.status, 'revoked');
    assert.doesNotThrow(() => EntitlementManager.revokeEntitlement(entitlement.id, 'admin-y', 'fraude suspeita'));
});
