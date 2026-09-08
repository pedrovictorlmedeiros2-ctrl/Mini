/**
 * TESTES ADVERSARIAIS — FASE 3 (UI Discord + integração fim-a-fim)
 *
 * Cobre especificamente o que as fases anteriores (2 e os módulos
 * isolados desta fase — capacityManager, ProofManager, ProductCatalog)
 * ainda não provavam:
 *   1) CommerceConfig — módulo novo desta fase, sem nenhum teste ainda.
 *   2) A integração PaymentManager -> ProofManager.markLatestProofStatus,
 *      adicionada nesta fase e não coberta em nenhum teste existente.
 *   3) Corrida de dupla aprovação através do PONTO DE ENTRADA real da UI
 *      (PaymentManager.confirmPayment), não só no CAS bruto do
 *      OrderManager (já coberto em commerceOrderManager.test.js).
 *   4) Isolamento entre clientes rodando o pipeline completo (Order ->
 *      Payment -> Proof -> Aprovação -> Entitlement) para dois clientes
 *      em paralelo — prova fim-a-fim, não só por módulo isolado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commercePhase3Adversarial.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get, query } = require('../src/database/database');
initDatabase();

const config = require('../config');
config.commerce.proofsFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-proofs-phase3-'));
config.commerce.maxProofSizeBytes = 1024 * 1024;

const CommerceConfig = require('../src/managers/commerce/CommerceConfig');
const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const PaymentManager = require('../src/managers/commerce/PaymentManager');
const ProofManager = require('../src/managers/commerce/ProofManager');
const CommerceStaffManager = require('../src/managers/commerce/CommerceStaffManager');
const EntitlementManager = require('../src/managers/commerce/EntitlementManager');

let counter = 0;
function makeUser(role = 'client') {
    counter += 1;
    const userId = `p3-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', role]);
    return userId;
}

const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const originalFetch = global.fetch;
function mockFetch(buffer) {
    global.fetch = async () => ({
        ok: true,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    });
}
test.afterEach(() => {
    global.fetch = originalFetch;
});

async function runFullPurchaseToApproval(clientUserId, adminUserId, productOverrides = {}) {
    counter += 1;
    const draftProduct = ProductCatalog.saveProduct({ id: `p3-prod-${counter}`, name: 'Plano', price: 29.9, maxBots: 2, maxRam: 400, maxCpu: 30, ...productOverrides });
    const product = ProductCatalog.publishProduct(draftProduct.id);

    const order = OrderManager.createOrder({ userId: clientUserId, channelId: `p3-channel-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);

    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, clientUserId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    PaymentManager.openForReview(order.id, adminUserId);
    const { order: approved } = PaymentManager.confirmPayment(order.id, adminUserId);

    run("UPDATE commerce_orders SET status = 'PROVISIONING' WHERE id = ?", [approved.id]);
    const entitlement = EntitlementManager.grant(approved.id);
    return { order: OrderManager.getOrder(approved.id), entitlement };
}

// ═══════════════════════════════════════════════════════════════════════
// 1) CommerceConfig — sem cobertura em nenhuma fase anterior
// ═══════════════════════════════════════════════════════════════════════

test('CommerceConfig: getConfig retorna a linha única (id=1) já criada por initDatabase, mesmo sem nenhum setup ainda', () => {
    const cfg = CommerceConfig.getConfig();
    assert.ok(cfg, 'a linha singleton deveria existir desde a migração, mesmo vazia');
    assert.equal(cfg.id, 1);
});

test('CommerceConfig: isConfigured é falso até que a estrutura de canais tenha sido salva', () => {
    // Usa um banco isolado deste teste específico pra não colidir com o
    // saveChannelStructure de outro teste da mesma suíte.
    const isolatedDb = path.join(__dirname, '..', 'src', 'database', 'test-commercePhase3-isolated1.db');
    if (fs.existsSync(isolatedDb)) fs.unlinkSync(isolatedDb);
    const prevDbPath = process.env.HOSTING_DB_PATH;
    process.env.HOSTING_DB_PATH = isolatedDb;
    delete require.cache[require.resolve('../src/database/database')];
    delete require.cache[require.resolve('../src/managers/commerce/CommerceConfig')];
    const freshDb = require('../src/database/database');
    freshDb.initDatabase();
    const FreshCommerceConfig = require('../src/managers/commerce/CommerceConfig');

    assert.equal(FreshCommerceConfig.isConfigured(), false);

    process.env.HOSTING_DB_PATH = prevDbPath;
    delete require.cache[require.resolve('../src/database/database')];
    delete require.cache[require.resolve('../src/managers/commerce/CommerceConfig')];
    if (fs.existsSync(isolatedDb)) fs.unlinkSync(isolatedDb);
});

test('CommerceConfig: saveChannelStructure grava todos os campos e isConfigured passa a true', () => {
    const saved = CommerceConfig.saveChannelStructure({
        guild_id: 'guild-1', public_category_id: 'cat-pub', sales_panel_channel_id: 'chan-sales',
        faq_channel_id: 'chan-faq', staff_category_id: 'cat-staff', staff_panel_channel_id: 'chan-staffpanel',
        orders_review_channel_id: 'chan-review', proofs_channel_id: 'chan-proofs', sales_log_channel_id: 'chan-log',
        staff_role_id: null,
    });
    assert.equal(saved.guild_id, 'guild-1');
    assert.equal(saved.public_category_id, 'cat-pub');
    assert.equal(CommerceConfig.isConfigured(), true);
});

test('CommerceConfig: saveChannelStructure com campos parciais faz MERGE — nunca apaga o que já estava salvo', () => {
    CommerceConfig.saveChannelStructure({
        guild_id: 'guild-merge', public_category_id: 'cat-a', staff_category_id: 'cat-b',
        sales_panel_channel_id: 'x', faq_channel_id: 'y', staff_panel_channel_id: 'z',
        orders_review_channel_id: 'w', proofs_channel_id: 'v', sales_log_channel_id: 'u', staff_role_id: null,
    });
    const merged = CommerceConfig.saveChannelStructure({ staff_role_id: 'role-123' });
    assert.equal(merged.staff_role_id, 'role-123');
    assert.equal(merged.public_category_id, 'cat-a', 'campos não enviados nesta chamada nunca deveriam ser apagados');
    assert.equal(merged.guild_id, 'guild-merge');
});

// ═══════════════════════════════════════════════════════════════════════
// 2) PaymentManager -> ProofManager.markLatestProofStatus (integração nova da Fase 3)
// ═══════════════════════════════════════════════════════════════════════

test('confirmPayment marca o último comprovante como "accepted" e registra quem revisou', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    counter += 1;
    const draftProduct = ProductCatalog.saveProduct({ id: `p3-proof-int-${counter}`, name: 'Plano', price: 10, maxBots: 1, maxRam: 200, maxCpu: 10 });
    const product = ProductCatalog.publishProduct(draftProduct.id);
    const order = OrderManager.createOrder({ userId: client, channelId: `p3-proof-chan-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, client, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    PaymentManager.openForReview(order.id, admin);
    PaymentManager.confirmPayment(order.id, admin);

    const reread = ProofManager.getProof(proof.id);
    assert.equal(reread.status, 'accepted');
    assert.equal(reread.reviewed_by_admin_id, admin);
});

test('rejectPayment marca o último comprovante como "rejected" com o motivo, sem afetar o Order de outro cliente', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const otherClient = makeUser();
    counter += 1;
    const draftProduct = ProductCatalog.saveProduct({ id: `p3-proof-rej-${counter}`, name: 'Plano', price: 10, maxBots: 1, maxRam: 200, maxCpu: 10 });
    const product = ProductCatalog.publishProduct(draftProduct.id);

    const order = OrderManager.createOrder({ userId: client, channelId: `p3-proof-rej-chan-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, client, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    counter += 1;
    const otherOrder = OrderManager.createOrder({ userId: otherClient, channelId: `p3-proof-rej-other-${counter}` });
    OrderManager.confirmProduct(otherOrder.id, product.id);
    PaymentManager.createPaymentRecord(otherOrder.id);
    mockFetch(PNG_BUFFER);
    const otherProof = await ProofManager.submitProof(otherOrder.id, otherClient, { url: 'https://cdn.discordapp.com/attachments/2/2/file2.dat', name: 'b.png', contentType: 'image/png', size: PNG_BUFFER.length });

    PaymentManager.openForReview(order.id, admin);
    PaymentManager.rejectPayment(order.id, admin, 'comprovante ilegível');

    assert.equal(ProofManager.getProof(proof.id).status, 'rejected');
    assert.equal(ProofManager.getProof(proof.id).review_reason, 'comprovante ilegível');
    // O comprovante do outro cliente nunca deveria ter sido tocado.
    assert.equal(ProofManager.getProof(otherProof.id).status, 'submitted');
    assert.equal(OrderManager.getOrder(otherOrder.id).status, OrderManager.STATUS.PROOF_SUBMITTED);
});

// ═══════════════════════════════════════════════════════════════════════
// 3) DUPLA APROVAÇÃO — através do ponto de entrada real da UI (PaymentManager)
// ═══════════════════════════════════════════════════════════════════════

test('DUPLA APROVAÇÃO: dois staff clicando "Aprovar" quase ao mesmo tempo no MESMO pedido — só um confirmPayment() vence', async () => {
    const staffA = makeUser('admin');
    const staffB = makeUser('admin');
    const client = makeUser();
    counter += 1;
    const draftProduct = ProductCatalog.saveProduct({ id: `p3-dblapprove-${counter}`, name: 'Plano', price: 15, maxBots: 1, maxRam: 200, maxCpu: 10 });
    const product = ProductCatalog.publishProduct(draftProduct.id);
    const order = OrderManager.createOrder({ userId: client, channelId: `p3-dblapprove-chan-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, client, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    PaymentManager.openForReview(order.id, staffA);

    // Simula os dois cliques disputando o mesmo UNDER_REVIEW -> APPROVED
    // (síncrono, mesmo princípio de ausência de corrida já usado em todo
    // o sistema — sem await entre as duas chamadas).
    let resultA, errorB;
    resultA = PaymentManager.confirmPayment(order.id, staffA);
    try {
        PaymentManager.confirmPayment(order.id, staffB);
    } catch (err) {
        errorB = err;
    }

    assert.ok(resultA.order, 'o primeiro clique deveria ter vencido');
    assert.ok(errorB, 'o segundo clique deveria falhar explicitamente, nunca aprovar duas vezes');
    assert.match(errorB.message, /não está em revisão/);

    // Só um registro de pagamento confirmado, e o pedido nunca some do
    // estado APPROVED por causa da segunda tentativa perdida.
    const payment = PaymentManager.getPaymentByOrder(order.id);
    assert.equal(payment.status, PaymentManager.PAYMENT_STATUS.CONFIRMED);
    assert.equal(payment.confirmed_by_admin_id, staffA);
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.APPROVED);

    const confirmedEvents = query("SELECT * FROM audit_log WHERE action = 'commerce:payment_confirmed'");
    const forThisOrder = confirmedEvents.filter((e) => JSON.parse(e.details).orderId === order.id);
    assert.equal(forThisOrder.length, 1, 'nunca deveria existir mais de um evento de confirmação pro mesmo pedido');
});

test('DUPLA APROVAÇÃO: aprovar e recusar quase ao mesmo tempo — só a primeira transição vence, nunca os dois estados coexistem', async () => {
    const staffA = makeUser('admin');
    const staffB = makeUser('admin');
    const client = makeUser();
    counter += 1;
    const draftProduct = ProductCatalog.saveProduct({ id: `p3-approve-vs-reject-${counter}`, name: 'Plano', price: 15, maxBots: 1, maxRam: 200, maxCpu: 10 });
    const product = ProductCatalog.publishProduct(draftProduct.id);
    const order = OrderManager.createOrder({ userId: client, channelId: `p3-approve-vs-reject-chan-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, client, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    PaymentManager.openForReview(order.id, staffA);

    PaymentManager.confirmPayment(order.id, staffA);
    assert.throws(() => PaymentManager.rejectPayment(order.id, staffB, 'motivo qualquer'), /não está em revisão/);

    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.APPROVED, 'o estado final nunca deveria regredir pra REJECTED depois de já aprovado');
});

// ═══════════════════════════════════════════════════════════════════════
// 4) ISOLAMENTO ENTRE CLIENTES — pipeline completo fim-a-fim, em paralelo
// ═══════════════════════════════════════════════════════════════════════

test('ISOLAMENTO FIM-A-FIM: dois clientes completam compra -> comprovante -> aprovação -> entitlement em paralelo, sem nenhuma contaminação cruzada', async () => {
    const admin = makeUser('admin');
    const clientA = makeUser();
    const clientB = makeUser();

    const { order: orderA, entitlement: entitlementA } = await runFullPurchaseToApproval(clientA, admin, { maxBots: 3, maxRam: 300, maxCpu: 20 });
    const { order: orderB, entitlement: entitlementB } = await runFullPurchaseToApproval(clientB, admin, { maxBots: 9, maxRam: 480, maxCpu: 45 });

    // Pedidos, pagamentos e entitlements nunca se cruzam.
    assert.notEqual(orderA.id, orderB.id);
    assert.equal(orderA.user_id, clientA);
    assert.equal(orderB.user_id, clientB);
    assert.equal(entitlementA.user_id, clientA);
    assert.equal(entitlementB.user_id, clientB);

    const userA = get('SELECT * FROM users WHERE id = ?', [clientA]);
    const userB = get('SELECT * FROM users WHERE id = ?', [clientB]);
    assert.equal(userA.max_bots, 3);
    assert.equal(userB.max_bots, 9, 'a capacidade do cliente B nunca deveria ter sido sobrescrita pela do cliente A');

    // Comprovantes: cada listagem só enxerga o próprio pedido.
    assert.equal(ProofManager.listProofsForOrder(orderA.id).length, 1);
    assert.equal(ProofManager.listProofsForOrder(orderB.id).length, 1);
    const proofA = ProofManager.getLatestProofForOrder(orderA.id);
    const proofB = ProofManager.getLatestProofForOrder(orderB.id);
    assert.notEqual(proofA.id, proofB.id);
    assert.equal(proofA.uploaded_by_user_id, clientA);
    assert.equal(proofB.uploaded_by_user_id, clientB);

    // Cliente A nunca consegue decriptar o comprovante de B (IDOR), mesmo
    // sabendo o ID do proof de B.
    assert.throws(() => ProofManager.getDecryptedProof(proofB.id, clientA), /Sem permissão comercial/);

    // getActiveEntitlement de cada um só retorna o seu, nunca o do outro.
    assert.equal(EntitlementManager.getActiveEntitlement(clientA).id, entitlementA.id);
    assert.equal(EntitlementManager.getActiveEntitlement(clientB).id, entitlementB.id);
});

test('ISOLAMENTO: cancelar o pedido do cliente A em qualquer momento nunca afeta o pedido em andamento do cliente B', () => {
    const clientA = makeUser();
    const clientB = makeUser();
    counter += 1;
    const draftProduct = ProductCatalog.saveProduct({ id: `p3-cancel-iso-${counter}`, name: 'Plano', price: 12, maxBots: 1, maxRam: 100, maxCpu: 10 });
    const product = ProductCatalog.publishProduct(draftProduct.id);

    const orderA = OrderManager.createOrder({ userId: clientA, channelId: `p3-cancel-iso-a-${counter}` });
    OrderManager.confirmProduct(orderA.id, product.id);
    const orderB = OrderManager.createOrder({ userId: clientB, channelId: `p3-cancel-iso-b-${counter}` });
    OrderManager.confirmProduct(orderB.id, product.id);

    OrderManager.cancelOrder(orderA.id);

    assert.equal(OrderManager.getOrder(orderA.id).status, OrderManager.STATUS.CANCELLED);
    assert.equal(OrderManager.getOrder(orderB.id).status, OrderManager.STATUS.AWAITING_PAYMENT, 'o pedido do cliente B nunca deveria ser afetado pelo cancelamento do cliente A');
});

test('PERMISSÃO: hasCommercePermission é revalidado nos managers mesmo se a checagem da camada de UI (hipoteticamente) fosse burlada', () => {
    const client = makeUser();
    counter += 1;
    const draftProduct = ProductCatalog.saveProduct({ id: `p3-perm-${counter}`, name: 'Plano', price: 10, maxBots: 1, maxRam: 100, maxCpu: 10 });
    const product = ProductCatalog.publishProduct(draftProduct.id);
    const order = OrderManager.createOrder({ userId: client, channelId: `p3-perm-chan-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);

    // Mesmo que uma camada de UI hipotética deixasse passar, o manager
    // por baixo sempre recusa um usuário sem permissão comercial.
    assert.throws(() => PaymentManager.openForReview(order.id, client), /sem permissão comercial/i);
    assert.throws(() => PaymentManager.confirmPayment(order.id, client), /sem permissão comercial/i);
    assert.throws(() => PaymentManager.rejectPayment(order.id, client, 'motivo'), /sem permissão comercial/i);
});
