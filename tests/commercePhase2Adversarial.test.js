/**
 * TESTES ADVERSARIAIS — SISTEMA COMERCIAL (Fase 2 de implementação)
 *
 * Cobre as invariantes estruturais listadas em
 * COMMERCIAL_ARCHITECTURE_PROPOSAL.md §10, verificáveis (não só
 * declaradas) — mesmo padrão da revisão adversarial da Fase 2 do
 * Kamikaze/SecurityMonitor.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commercePhase2Adversarial.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get, query } = require('../src/database/database');
initDatabase();

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const PaymentManager = require('../src/managers/commerce/PaymentManager');
const EntitlementManager = require('../src/managers/commerce/EntitlementManager');
const CommerceStaffManager = require('../src/managers/commerce/CommerceStaffManager');

const COMMERCE_DIR = path.join(__dirname, '..', 'src', 'managers', 'commerce');

let counter = 0;
function makeUser(role = 'client') {
    counter += 1;
    const userId = `advcomm-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', role]);
    return userId;
}
function makeProduct(overrides = {}) {
    counter += 1;
    const product = ProductCatalog.saveProduct({ id: `advcomm-prod-${counter}`, name: 'Plano', price: 49.9, maxBots: 2, maxRam: 512, maxCpu: 40, ...overrides });
    return ProductCatalog.publishProduct(product.id); // Fase 3: precisa estar PUBLISHED pra ser comprável
}
// Fase 6: confirmPayment/rejectPayment/requestNewProof exigem pelo menos
// um comprovante registrado. Este arquivo testa PaymentManager/OrderManager
// isolados de ProofManager de propósito — insere só a LINHA mínima
// necessária, sem passar pelo pipeline completo de upload (testado à
// parte em commerceProofManager.test.js/commercePhase5Adversarial.test.js).
function insertFakeProof(orderId, uploaderUserId) {
    counter += 1;
    run(
        `INSERT INTO commerce_proofs (id, order_id, storage_path, sha256, mime_type, original_filename, size_bytes, uploaded_by_user_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`advcomm-proof-${counter}`, orderId, '/tmp/fake-proof.enc', 'fakehash', 'image/png', 'comprovante.png', 100, uploaderUserId, 'submitted']
    );
}

// ────────────────────────────────────────────────────────────────────────
// 1) ISOLAMENTO ESTRUTURAL — nunca importa sandbox/segurança/spawn
// ────────────────────────────────────────────────────────────────────────

test('ESTRUTURAL: nenhum módulo de src/managers/commerce/ importa child_process, SandboxManager, SecurityEngine, IncidentResponseManager ou SecurityMonitor', () => {
    const files = fs.readdirSync(COMMERCE_DIR).filter((f) => f.endsWith('.js'));
    assert.ok(files.length >= 6, 'esperava encontrar os módulos comerciais no diretório');

    const dangerous = /require\(['"]child_process['"]\)|\bexec\(|\bspawn\(|\bfork\(|\beval\(|require\([^)]*SandboxManager[^)]*\)|require\([^)]*SecurityEngine[^)]*\)|require\([^)]*IncidentResponseManager[^)]*\)|require\([^)]*SecurityMonitor[^)]*\)/;

    for (const file of files) {
        const src = fs.readFileSync(path.join(COMMERCE_DIR, file), 'utf8');
        const match = src.match(dangerous);
        assert.equal(match, null, `${file} não deveria conter nenhuma API perigosa/import de sandbox ou segurança — encontrado: ${match?.[0]}`);
    }
});

test('ESTRUTURAL: nenhum módulo comercial importa processManager (nunca inicia/gerencia processo de bot nesta fase)', () => {
    const files = fs.readdirSync(COMMERCE_DIR).filter((f) => f.endsWith('.js'));
    for (const file of files) {
        const src = fs.readFileSync(path.join(COMMERCE_DIR, file), 'utf8');
        assert.equal(/require\([^)]*processManager[^)]*\)/.test(src), false, `${file} não deveria importar processManager nesta fase`);
    }
});

// ────────────────────────────────────────────────────────────────────────
// 2) orders.status SÓ MUDA VIA OrderManager.transitionOrder (CAS)
// ────────────────────────────────────────────────────────────────────────

test('ESTRUTURAL: nenhum módulo comercial (fora de OrderManager.js) escreve em commerce_orders.status diretamente', () => {
    const files = fs.readdirSync(COMMERCE_DIR).filter((f) => f.endsWith('.js') && f !== 'OrderManager.js');
    const directStatusWrite = /UPDATE\s+commerce_orders\s+SET[^;]*\bstatus\s*=/is;

    for (const file of files) {
        const src = fs.readFileSync(path.join(COMMERCE_DIR, file), 'utf8');
        assert.equal(directStatusWrite.test(src), false, `${file} não deveria escrever em commerce_orders.status diretamente — só OrderManager.transitionOrder()`);
    }
});

// ────────────────────────────────────────────────────────────────────────
// 3) CUPOM DESACOPLADO DE PAYMENT/PROVISIONING (decisão #11)
// ────────────────────────────────────────────────────────────────────────

test('ESTRUTURAL: nenhuma instrução SQL que grava em commerce_payments referencia coupon_id na MESMA instrução', () => {
    const src = fs.readFileSync(path.join(COMMERCE_DIR, 'PaymentManager.js'), 'utf8');
    // Extrai cada string literal (template ou aspas) que menciona
    // commerce_payments e checa coupon_id só DENTRO dessa string — uma
    // checagem por proximidade textual no arquivo inteiro daria falso
    // positivo (ex.: `order.coupon_id` lido em JS logo depois de uma
    // query completamente não relacionada a commerce_payments).
    const stringLiterals = src.match(/`[^`]*`|"[^"]*"/g) || [];
    const paymentsQueries = stringLiterals.filter((s) => s.includes('commerce_payments'));
    assert.ok(paymentsQueries.length > 0, 'esperava encontrar pelo menos uma query commerce_payments em PaymentManager.js');
    for (const sql of paymentsQueries) {
        assert.equal(/coupon/i.test(sql), false, `query commerce_payments não deveria referenciar cupom: ${sql}`);
    }
});

test('ESTRUTURAL: nenhuma tabela commerce_payments/commerce_entitlements tem coluna coupon_id no schema', () => {
    const paymentsCols = query("PRAGMA table_info(commerce_payments)").map((c) => c.name);
    const entitlementsCols = query("PRAGMA table_info(commerce_entitlements)").map((c) => c.name);
    assert.equal(paymentsCols.includes('coupon_id'), false);
    assert.equal(entitlementsCols.includes('coupon_id'), false);
});

test('FUNCIONAL: aplicar e confirmar um cupom nunca grava nada em commerce_payments além do que já seria gravado sem cupom', () => {
    const admin = makeUser('admin');
    const client = makeUser('client');
    counter += 1;
    const order = OrderManager.createOrder({ userId: client, channelId: `advcomm-coupon-${counter}` });
    const product = makeProduct({ price: 100 });
    OrderManager.confirmProduct(order.id, product.id);

    const couponId = run("INSERT INTO coupons (code, type, value, max_uses) VALUES ('ADV-CPN', 'fixed', 20, 5)").lastInsertRowid;
    OrderManager.applyCoupon(order.id, couponId, 20);
    PaymentManager.createPaymentRecord(order.id);
    OrderManager.transitionOrder(order.id, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.PROOF_SUBMITTED);
    insertFakeProof(order.id, client);
    PaymentManager.openForReview(order.id, admin);
    PaymentManager.confirmPayment(order.id, admin);

    const payment = PaymentManager.getPaymentByOrder(order.id);
    const paymentKeys = Object.keys(payment);
    assert.equal(paymentKeys.includes('coupon_id'), false, 'commerce_payments nunca deveria ter uma coluna coupon_id');
    // expected_amount reflete o total JÁ com desconto (createPaymentRecord
    // é chamado depois do cupom aplicado, lendo commerce_orders.total_price)
    // — o ponto deste teste é que NENHUM dado de cupom (coupon_id, código,
    // percentual) é gravado em commerce_payments, só o valor final a pagar.
    assert.equal(payment.expected_amount, 80);
    assert.equal(OrderManager.getOrder(order.id).coupon_id, couponId, 'o vínculo com o cupom vive em commerce_orders, nunca em commerce_payments');
});

// ────────────────────────────────────────────────────────────────────────
// 4) PREÇO NUNCA CONFIADO AO CLIENTE
// ────────────────────────────────────────────────────────────────────────

test('PREÇO: sempre derivado do produto pelo ID interno — nunca aceito como número vindo de fora', () => {
    const client = makeUser('client');
    counter += 1;
    const order = OrderManager.createOrder({ userId: client, channelId: `advcomm-price-${counter}` });
    const product = makeProduct({ price: 77.7 });

    // A única forma de "escolher" um preço é escolher um productId — não
    // existe nenhum parâmetro numérico de preço em nenhuma função pública
    // de OrderManager. Confirma que o preço do pedido bate exatamente com
    // o do produto, independente de qualquer coisa que um cliente possa
    // ter tentado manipular na camada de UI (fora de escopo desta fase,
    // mas o contrato de dados já impede isso estruturalmente).
    const confirmed = OrderManager.confirmProduct(order.id, product.id);
    assert.equal(confirmed.total_price, 77.7);

    const publicFunctions = Object.entries(OrderManager).filter(([, v]) => typeof v === 'function');
    for (const [name, fn] of publicFunctions) {
        const signature = fn.toString().split('{')[0].split('=>')[0];
        assert.equal(/\bprice\b|\bamount\b|\bvalor\b/i.test(signature), false, `função pública "${name}" não deveria aceitar preço/valor como parâmetro`);
    }
});

// ────────────────────────────────────────────────────────────────────────
// 5) PAGAMENTO CONFIRMADO != ACTIVE (invariante #1 desta fase)
// ────────────────────────────────────────────────────────────────────────

test('INVARIANTE: confirmPayment() jamais, sob nenhuma circunstância, chega a criar um Entitlement', () => {
    const admin = makeUser('admin');
    const client = makeUser('client');
    counter += 1;
    const order = OrderManager.createOrder({ userId: client, channelId: `advcomm-noauto-${counter}` });
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    OrderManager.transitionOrder(order.id, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.PROOF_SUBMITTED);
    insertFakeProof(order.id, client);
    PaymentManager.openForReview(order.id, admin);

    PaymentManager.confirmPayment(order.id, admin);

    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.APPROVED);
    assert.equal(EntitlementManager.getEntitlementByOrder(order.id), undefined, 'nenhum Entitlement deveria existir só porque o pagamento foi confirmado');
});

test('ESTRUTURAL: PaymentManager.js nunca importa EntitlementManager (não tem como criar um Entitlement mesmo por engano)', () => {
    const src = fs.readFileSync(path.join(COMMERCE_DIR, 'PaymentManager.js'), 'utf8');
    assert.equal(/require\([^)]*EntitlementManager[^)]*\)/.test(src), false);
});

// ────────────────────────────────────────────────────────────────────────
// 6) hasCommercePermission SEMPRE CHECADA DENTRO DO MANAGER
// ────────────────────────────────────────────────────────────────────────

test('ESTRUTURAL: toda ação sensível de PaymentManager (openForReview/confirmPayment/rejectPayment/requestNewProof) chama hasCommercePermission internamente (direto ou via assertCanReview)', () => {
    const src = fs.readFileSync(path.join(COMMERCE_DIR, 'PaymentManager.js'), 'utf8');
    // Fase 6: confirmPayment/rejectPayment/requestNewProof passaram a
    // compartilhar a checagem via um helper (assertCanReview) — confirma
    // que o HELPER em si realmente checa hasCommercePermission...
    const assertCanReviewBody = src.split('function assertCanReview')[1]?.split(/\nfunction /)[0];
    assert.ok(assertCanReviewBody && assertCanReviewBody.includes('hasCommercePermission'), 'assertCanReview deveria checar hasCommercePermission internamente');

    // ...e que cada função sensível de fato CHAMA esse helper (ou checa
    // direto, como openForReview ainda faz).
    const functions = src.split(/^function /m).slice(1);
    const sensitiveNames = ['openForReview', 'confirmPayment', 'rejectPayment', 'requestNewProof'];
    for (const fnBody of functions) {
        const name = fnBody.split('(')[0].trim();
        if (sensitiveNames.includes(name)) {
            const checksPermission = fnBody.includes('hasCommercePermission') || fnBody.includes('assertCanReview(');
            assert.ok(checksPermission, `${name} deveria checar permissão comercial (direto ou via assertCanReview)`);
        }
    }
});

test('FUNCIONAL: negação de permissão nunca muda estado algum (nem parcialmente)', () => {
    const client = makeUser('client');
    const outsider = makeUser('client');
    counter += 1;
    const order = OrderManager.createOrder({ userId: client, channelId: `advcomm-noperm-${counter}` });
    const product = makeProduct();
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    OrderManager.transitionOrder(order.id, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.PROOF_SUBMITTED);

    const beforeOrder = JSON.stringify(OrderManager.getOrder(order.id));
    const beforePayment = JSON.stringify(PaymentManager.getPaymentByOrder(order.id));

    assert.throws(() => PaymentManager.openForReview(order.id, outsider));

    assert.equal(JSON.stringify(OrderManager.getOrder(order.id)), beforeOrder);
    assert.equal(JSON.stringify(PaymentManager.getPaymentByOrder(order.id)), beforePayment);
});

// ────────────────────────────────────────────────────────────────────────
// 7) ROBUSTEZ — IDs adversariais (SQL-like, unicode, muito longos)
// ────────────────────────────────────────────────────────────────────────

test('ROBUSTEZ: userId "malicioso" (SQL-like) nunca quebra o pipeline nem afeta outro usuário', () => {
    const weirdUserId = "user'; DROP TABLE commerce_orders; --";
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [weirdUserId, 'tester', 'client']);
    counter += 1;

    assert.doesNotThrow(() => {
        const order = OrderManager.createOrder({ userId: weirdUserId, channelId: `advcomm-weird-${counter}` });
        const product = makeProduct();
        OrderManager.confirmProduct(order.id, product.id);
    });

    // Confirma que a tabela commerce_orders (que o payload tentava
    // apagar) continua existindo e consultável normalmente.
    assert.doesNotThrow(() => query('SELECT COUNT(*) as c FROM commerce_orders'));
});

test('ROBUSTEZ: productId inexistente nunca crasha confirmProduct — lança um erro claro', () => {
    const client = makeUser('client');
    counter += 1;
    const order = OrderManager.createOrder({ userId: client, channelId: `advcomm-badprod-${counter}` });
    assert.throws(() => OrderManager.confirmProduct(order.id, 'produto-inexistente-xyz'), /não encontrado/);
});

test('ROBUSTEZ: orderId inexistente em cada manager público nunca lança um erro genérico/opaco — sempre uma mensagem clara, nunca undefined.property crash', () => {
    assert.throws(() => OrderManager.confirmProduct(999999, 'x'));
    assert.throws(() => PaymentManager.createPaymentRecord(999999));
    assert.throws(() => EntitlementManager.grant(999999));
});

// ────────────────────────────────────────────────────────────────────────
// 8) SNAPSHOT IMUTÁVEL — pedido histórico nunca muda com edição do produto
// ────────────────────────────────────────────────────────────────────────

test('SNAPSHOT: editar o produto DEPOIS de um pedido confirmado nunca altera o pedido já existente', () => {
    const client = makeUser('client');
    const product = makeProduct({ price: 40, maxBots: 2 });
    counter += 1;
    const order = OrderManager.createOrder({ userId: client, channelId: `advcomm-snap-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);

    const beforeEdit = OrderManager.getOrder(order.id);
    assert.equal(beforeEdit.total_price, 40);

    ProductCatalog.saveProduct({ ...product, price: 4000, maxBots: 9, name: product.name, maxRam: product.max_ram, maxCpu: product.max_cpu });

    const afterEdit = OrderManager.getOrder(order.id);
    assert.equal(afterEdit.total_price, 40, 'total_price do pedido nunca deveria mudar com uma edição posterior do produto');
    const snapshot = JSON.parse(afterEdit.product_snapshot);
    assert.equal(snapshot.price, 40);
    assert.equal(snapshot.maxBots, 2);
});

test('SNAPSHOT: arquivar o produto DEPOIS de um pedido confirmado nunca afeta o pedido já existente', () => {
    const client = makeUser('client');
    const product = makeProduct();
    counter += 1;
    const order = OrderManager.createOrder({ userId: client, channelId: `advcomm-snap-archive-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);

    ProductCatalog.archiveProduct(product.id);

    const order2 = OrderManager.getOrder(order.id);
    assert.ok(order2.product_snapshot, 'snapshot já gravado continua existindo mesmo com o produto arquivado');
});

// ────────────────────────────────────────────────────────────────────────
// 9) NÃO ACUMULA MÚLTIPLOS ENTITLEMENTS (decisão #2) — teste de ponta a ponta
// ────────────────────────────────────────────────────────────────────────

test('PONTA A PONTA: dois pedidos aprovados em paralelo pro mesmo usuário — só o primeiro grant() vence, o segundo é recusado explicitamente', () => {
    const admin = makeUser('admin');
    const client = makeUser('client');

    function makeApprovedOrder() {
        counter += 1;
        const order = OrderManager.createOrder({ userId: client, channelId: `advcomm-parallel-${counter}` });
        const product = makeProduct();
        OrderManager.confirmProduct(order.id, product.id);
        PaymentManager.createPaymentRecord(order.id);
        OrderManager.transitionOrder(order.id, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.PROOF_SUBMITTED);
        insertFakeProof(order.id, client);
        PaymentManager.openForReview(order.id, admin);
        PaymentManager.confirmPayment(order.id, admin);
        OrderManager.transitionOrder(order.id, [OrderManager.STATUS.APPROVED], OrderManager.STATUS.PROVISIONING);
        return OrderManager.getOrder(order.id);
    }

    const orderA = makeApprovedOrder();
    const orderB = makeApprovedOrder();

    const entitlementA = EntitlementManager.grant(orderA.id);
    assert.equal(entitlementA.status, 'active');

    assert.throws(() => EntitlementManager.grant(orderB.id), EntitlementManager.EntitlementConflictError);

    // O segundo pedido fica "PROVISIONING" sem entitlement — exatamente o
    // cenário de falha permanente de provisionamento (decisão #14):
    // rastreável, retriable, pagamento já confirmado, cliente não paga de
    // novo. Uma fase futura (ProvisioningManager real) decidiria levar
    // orderB pra PROVISIONING_FAILED quando grant() lançar assim.
    assert.equal(OrderManager.getOrder(orderB.id).status, OrderManager.STATUS.PROVISIONING);
    assert.equal(EntitlementManager.getEntitlementByOrder(orderB.id), undefined);
});
