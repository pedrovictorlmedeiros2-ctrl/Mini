/**
 * TESTES ADVERSARIAIS — FASE 6 (revisão, aprovação e rejeição de pagamentos)
 *
 * Cobre especificamente o que a Fase 6 pediu:
 *   1) Máquina de estados nova (NEEDS_NEW_PROOF) — ciclo completo e os
 *      atalhos proibidos (AWAITING_PAYMENT/PROOF_SUBMITTED/UNDER_REVIEW
 *      → ACTIVE direto).
 *   2) Guarda dupla persistente (Gate 1 Order + Gate 2 Payment, ambos com
 *      `changes` checado) em confirmPayment/rejectPayment — nunca reporta
 *      sucesso sobre uma operação que não bateu de verdade.
 *   3) Segregação de função (ninguém revisa o próprio pedido) e exigência
 *      de comprovante válido antes de qualquer decisão.
 *   4) Concorrência: dois staffs aprovando o mesmo pedido, aprovação vs.
 *      rejeição, aprovação vs. "pedir novo comprovante" — tudo
 *      disputando o mesmo CAS do Order.
 *   5) Privilege escalation (cliente comum, moderator sem COMMERCE_STAFF),
 *      staff revogado durante a revisão.
 *   6) requestNewProof: ciclo completo preservando histórico, Payment
 *      nunca tocado, nunca ativa nada sozinho.
 *   7) capacityManager nunca é contornado por este módulo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commercePhase6Adversarial.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get, query } = require('../src/database/database');
initDatabase();

const config = require('../config');
config.commerce.proofsFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-proofs-phase6-'));
config.commerce.maxProofSizeBytes = 1024 * 1024;

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const PaymentManager = require('../src/managers/commerce/PaymentManager');
const ProofManager = require('../src/managers/commerce/ProofManager');
const CommerceStaffManager = require('../src/managers/commerce/CommerceStaffManager');

let counter = 0;
function makeUser(role = 'client') {
    counter += 1;
    const userId = `p6-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', role]);
    return userId;
}
function makePublishedProduct(overrides = {}) {
    counter += 1;
    const draft = ProductCatalog.saveProduct({ id: `p6-prod-${counter}`, name: 'Plano', price: 29.9, maxBots: 2, maxRam: 400, maxCpu: 30, ...overrides });
    return ProductCatalog.publishProduct(draft.id);
}
// Insere só a linha mínima de comprovante — usado quando o teste quer
// isolar o Gate 1 (Order) sem passar pelo pipeline completo de upload.
function insertFakeProof(orderId, uploaderUserId) {
    counter += 1;
    run(
        `INSERT INTO commerce_proofs (id, order_id, storage_path, sha256, mime_type, original_filename, size_bytes, uploaded_by_user_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`p6-fakeproof-${counter}`, orderId, '/tmp/fake-proof.enc', 'fakehash', 'image/png', 'comprovante.png', 100, uploaderUserId, 'submitted']
    );
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

/** Pipeline completo e realista até UNDER_REVIEW: produto -> pedido -> payment -> comprovante -> abrir revisão. */
async function makeOrderUnderReview(clientUserId, adminUserId) {
    const product = makePublishedProduct();
    counter += 1;
    const order = OrderManager.createOrder({ userId: clientUserId, channelId: `p6-channel-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, clientUserId, { url: 'https://cdn.discordapp.com/attachments/1/1/a.png', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    PaymentManager.openForReview(order.id, adminUserId);
    return OrderManager.getOrder(order.id);
}

// ═══════════════════════════════════════════════════════════════════════
// 1) MÁQUINA DE ESTADOS — NEEDS_NEW_PROOF (ciclo completo) e atalhos proibidos
// ═══════════════════════════════════════════════════════════════════════

test('CICLO COMPLETO: UNDER_REVIEW -> NEEDS_NEW_PROOF -> (reenvio) -> UNDER_REVIEW -> APPROVED, preservando os dois comprovantes', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, admin);

    const afterRequest = PaymentManager.requestNewProof(order.id, admin, 'comprovante ilegível, manda outro');
    assert.equal(afterRequest.status, OrderManager.STATUS.NEEDS_NEW_PROOF);
    assert.equal(afterRequest.rejection_reason, 'comprovante ilegível, manda outro');
    // Payment nunca é tocado por requestNewProof — continua aguardando.
    assert.equal(PaymentManager.getPaymentByOrder(order.id).status, 'awaiting_proof');

    mockFetch(PNG_BUFFER);
    const secondProof = await ProofManager.submitProof(order.id, client, { url: 'https://cdn.discordapp.com/attachments/2/2/b.png', name: 'b.png', contentType: 'image/png', size: PNG_BUFFER.length });

    const afterResubmit = OrderManager.getOrder(order.id);
    assert.equal(afterResubmit.status, OrderManager.STATUS.UNDER_REVIEW, 'reenvio depois de NEEDS_NEW_PROOF volta direto pra UNDER_REVIEW');

    const history = ProofManager.listProofsForOrder(order.id);
    assert.equal(history.length, 2, 'o comprovante anterior nunca é apagado — histórico preservado');
    assert.equal(history[1].id, secondProof.id);

    const { order: approved } = PaymentManager.confirmPayment(order.id, admin);
    assert.equal(approved.status, OrderManager.STATUS.APPROVED);
});

test('NEEDS_NEW_PROOF: cliente pode cancelar em vez de reenviar', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, admin);
    PaymentManager.requestNewProof(order.id, admin, 'motivo qualquer');

    const cancelled = OrderManager.cancelOrder(order.id);
    assert.equal(cancelled.status, OrderManager.STATUS.CANCELLED);
});

test('REJECTED é terminal: cliente recusado em definitivo NUNCA consegue enviar novo comprovante (não é uma transição válida)', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, admin);
    PaymentManager.rejectPayment(order.id, admin, 'recusado em definitivo');

    mockFetch(PNG_BUFFER);
    await assert.rejects(
        () => ProofManager.submitProof(order.id, client, { url: 'https://cdn.discordapp.com/attachments/3/3/c.png', name: 'c.png', contentType: 'image/png', size: PNG_BUFFER.length }),
        /não está aceitando comprovante/
    );
});

test('ATALHOS PROIBIDOS: AWAITING_PAYMENT/PROOF_SUBMITTED/UNDER_REVIEW -> ACTIVE nunca são transições válidas', () => {
    counter += 1;
    const order = OrderManager.createOrder({ userId: makeUser(), channelId: `p6-shortcut-${counter}` });
    assert.throws(() => OrderManager.transitionOrder(order.id, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.ACTIVE), /não é válida na máquina de estados/);
    assert.throws(() => OrderManager.transitionOrder(order.id, [OrderManager.STATUS.PROOF_SUBMITTED], OrderManager.STATUS.ACTIVE), /não é válida na máquina de estados/);
    assert.throws(() => OrderManager.transitionOrder(order.id, [OrderManager.STATUS.UNDER_REVIEW], OrderManager.STATUS.ACTIVE), /não é válida na máquina de estados/);
    assert.throws(() => OrderManager.transitionOrder(order.id, [OrderManager.STATUS.NEEDS_NEW_PROOF], OrderManager.STATUS.ACTIVE), /não é válida na máquina de estados/);
});

test('ESTRUTURAL: VALID_TRANSITIONS não contém nenhum atalho pra ACTIVE fora de PROVISIONING', () => {
    for (const [from, tos] of Object.entries(OrderManager.VALID_TRANSITIONS)) {
        if (from === OrderManager.STATUS.PROVISIONING) continue;
        assert.equal(tos.includes(OrderManager.STATUS.ACTIVE), false, `${from} nunca deveria poder ir direto pra ACTIVE`);
    }
});

// ═══════════════════════════════════════════════════════════════════════
// 2) GUARDA DUPLA PERSISTENTE (Gate 1 Order + Gate 2 Payment)
// ═══════════════════════════════════════════════════════════════════════

test('GATE PAYMENT: "payment inexistente" — deletar o Payment antes de aprovar nunca reporta sucesso, é auditado como inconsistência', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, admin);
    run('DELETE FROM commerce_payments WHERE order_id = ?', [order.id]);

    assert.throws(() => PaymentManager.confirmPayment(order.id, admin), /o pagamento não pôde ser confirmado/);

    const anomalies = query("SELECT * FROM audit_log WHERE action = 'commerce:payment_confirm_inconsistency'");
    assert.ok(anomalies.some((r) => JSON.parse(r.details).orderId === order.id), 'a inconsistência deveria ter sido auditada');
});

test('GATE PAYMENT: "payment já confirmado" (inconsistência forçada: Order volta a UNDER_REVIEW mas Payment continua confirmed) — aprovar de novo nunca reporta sucesso', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, admin);
    PaymentManager.confirmPayment(order.id, admin);
    assert.equal(PaymentManager.getPaymentByOrder(order.id).status, 'confirmed');

    // Força uma inconsistência artificial: Order volta pra UNDER_REVIEW
    // (via SQL direto, simulando um bug/corrupção hipotética), mas o
    // Payment continua 'confirmed'. Isso NUNCA acontece por um caminho
    // normal do código — é exatamente o cenário adversarial pedido.
    run("UPDATE commerce_orders SET status = 'UNDER_REVIEW' WHERE id = ?", [order.id]);

    assert.throws(() => PaymentManager.confirmPayment(order.id, admin), /o pagamento não pôde ser confirmado/);
    // O Payment nunca foi "reconfirmado" por engano — continua exatamente como estava.
    const payment = PaymentManager.getPaymentByOrder(order.id);
    assert.equal(payment.status, 'confirmed');
});

test('GATE PAYMENT: mesma proteção vale para rejectPayment (payment inexistente)', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, admin);
    run('DELETE FROM commerce_payments WHERE order_id = ?', [order.id]);

    assert.throws(() => PaymentManager.rejectPayment(order.id, admin, 'motivo'), /o pagamento não pôde ser recusado/);
});

test('APROVAÇÃO DE PEDIDO JÁ APROVADO: segunda chamada nunca reaprova nem duplica efeitos', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, admin);
    PaymentManager.confirmPayment(order.id, admin);

    assert.throws(() => PaymentManager.confirmPayment(order.id, admin), /não está em revisão/);
    const confirmedEvents = query("SELECT * FROM audit_log WHERE action = 'commerce:payment_confirmed'").filter((r) => JSON.parse(r.details).orderId === order.id);
    assert.equal(confirmedEvents.length, 1, 'nunca deveria existir mais de um evento de confirmação pro mesmo pedido');
});

test('APROVAÇÃO DE PEDIDO CANCELADO: nunca é possível aprovar um pedido que o cliente já cancelou', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    counter += 1;
    const product = makePublishedProduct();
    const order = OrderManager.createOrder({ userId: client, channelId: `p6-cancelled-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    insertFakeProof(order.id, client);
    OrderManager.cancelOrder(order.id);

    assert.throws(() => PaymentManager.confirmPayment(order.id, admin), /não está em revisão/);
});

test('APROVAÇÃO DE PEDIDO EXPIRADO: nunca é possível aprovar um pedido que expirou por falta de comprovante', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    counter += 1;
    const product = makePublishedProduct();
    const order = OrderManager.createOrder({ userId: client, channelId: `p6-expired-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    insertFakeProof(order.id, client);
    OrderManager.transitionOrder(order.id, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.EXPIRED);

    assert.throws(() => PaymentManager.confirmPayment(order.id, admin), /não está em revisão/);
});

// ═══════════════════════════════════════════════════════════════════════
// 3) SEGREGAÇÃO DE FUNÇÃO / COMPROVANTE VÁLIDO OBRIGATÓRIO
// ═══════════════════════════════════════════════════════════════════════

test('AUTOAPROVAÇÃO: um staff nunca pode aprovar/recusar/pedir novo comprovante no PRÓPRIO pedido', async () => {
    const staffWhoIsAlsoBuyer = makeUser('admin'); // admin E comprador do mesmo pedido
    const order = await makeOrderUnderReview(staffWhoIsAlsoBuyer, makeUser('admin'));
    // reabre em UNDER_REVIEW já que makeOrderUnderReview usou um admin diferente pra abrir — agora o próprio comprador (que também é admin) tenta agir.
    assert.throws(() => PaymentManager.confirmPayment(order.id, staffWhoIsAlsoBuyer), /não pode revisar/);
    assert.throws(() => PaymentManager.rejectPayment(order.id, staffWhoIsAlsoBuyer, 'motivo'), /não pode revisar/);
    assert.throws(() => PaymentManager.requestNewProof(order.id, staffWhoIsAlsoBuyer, 'motivo'), /não pode revisar/);
    // O pedido continua intocado depois das tentativas.
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.UNDER_REVIEW);
});

test('COMPROVANTE VÁLIDO OBRIGATÓRIO: aprovar um pedido sem nenhum comprovante registrado (estado forçado) é recusado', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    counter += 1;
    const product = makePublishedProduct();
    const order = OrderManager.createOrder({ userId: client, channelId: `p6-noproof-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    // Força o pedido pra UNDER_REVIEW sem NUNCA ter passado por um
    // submitProof() de verdade — cenário estruturalmente impossível pelo
    // fluxo normal, testado aqui como defesa em profundidade.
    OrderManager.transitionOrder(order.id, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.PROOF_SUBMITTED);
    OrderManager.transitionOrder(order.id, [OrderManager.STATUS.PROOF_SUBMITTED], OrderManager.STATUS.UNDER_REVIEW);

    assert.throws(() => PaymentManager.confirmPayment(order.id, admin), /não tem nenhum comprovante enviado/);
});

// ═══════════════════════════════════════════════════════════════════════
// 4) CONCORRÊNCIA — três disputas diferentes pelo mesmo CAS do Order
// ═══════════════════════════════════════════════════════════════════════

test('CONCORRÊNCIA: dois staffs aprovando o MESMO pedido quase ao mesmo tempo — só um vence', async () => {
    const staffA = makeUser('admin');
    const staffB = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, staffA);

    const resultA = PaymentManager.confirmPayment(order.id, staffA);
    assert.throws(() => PaymentManager.confirmPayment(order.id, staffB), /não está em revisão/);
    assert.equal(resultA.order.status, OrderManager.STATUS.APPROVED);
});

test('CONCORRÊNCIA: aprovação e rejeição disputando o mesmo pedido — só a primeira transição vence', async () => {
    const staffA = makeUser('admin');
    const staffB = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, staffA);

    PaymentManager.confirmPayment(order.id, staffA);
    assert.throws(() => PaymentManager.rejectPayment(order.id, staffB, 'motivo'), /não está em revisão/);
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.APPROVED);
});

test('CONCORRÊNCIA: aprovação e "pedir novo comprovante" disputando o mesmo pedido — só a primeira transição vence', async () => {
    const staffA = makeUser('admin');
    const staffB = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, staffA);

    PaymentManager.requestNewProof(order.id, staffA, 'pede de novo');
    assert.throws(() => PaymentManager.confirmPayment(order.id, staffB), /não está em revisão/);
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.NEEDS_NEW_PROOF);
});

test('CONCORRÊNCIA: "pedir novo comprovante" duas vezes — só a primeira vence', async () => {
    const staffA = makeUser('admin');
    const staffB = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, staffA);

    PaymentManager.requestNewProof(order.id, staffA, 'motivo A');
    assert.throws(() => PaymentManager.requestNewProof(order.id, staffB, 'motivo B'), /não está em revisão/);
    assert.equal(OrderManager.getOrder(order.id).rejection_reason, 'motivo A');
});

// ═══════════════════════════════════════════════════════════════════════
// 5) PRIVILEGE ESCALATION / STAFF REVOGADO
// ═══════════════════════════════════════════════════════════════════════

test('PRIVILEGE ESCALATION: cliente comum não consegue aprovar/recusar/pedir novo comprovante', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const randomClient = makeUser();
    const order = await makeOrderUnderReview(client, admin);

    assert.throws(() => PaymentManager.confirmPayment(order.id, randomClient), /sem permissão comercial/);
    assert.throws(() => PaymentManager.rejectPayment(order.id, randomClient, 'motivo'), /sem permissão comercial/);
    assert.throws(() => PaymentManager.requestNewProof(order.id, randomClient, 'motivo'), /sem permissão comercial/);
});

test('PRIVILEGE ESCALATION: moderator SEM COMMERCE_STAFF não tem autoridade comercial nenhuma', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const moderator = makeUser('moderator');
    const order = await makeOrderUnderReview(client, admin);

    assert.equal(CommerceStaffManager.hasCommercePermission(moderator), false);
    assert.throws(() => PaymentManager.confirmPayment(order.id, moderator), /sem permissão comercial/);
});

test('STAFF REVOGADO DURANTE A REVISÃO: perde a capacidade de agir imediatamente após a revogação', async () => {
    const admin = makeUser('admin');
    const staff = makeUser();
    CommerceStaffManager.grant(staff, admin);
    const client = makeUser();
    const order = await makeOrderUnderReview(client, staff); // abre a revisão enquanto AINDA tem permissão

    CommerceStaffManager.revoke(staff, admin);

    assert.throws(() => PaymentManager.confirmPayment(order.id, staff), /sem permissão comercial/);
    assert.throws(() => PaymentManager.rejectPayment(order.id, staff, 'motivo'), /sem permissão comercial/);
    assert.throws(() => PaymentManager.requestNewProof(order.id, staff, 'motivo'), /sem permissão comercial/);
    // O pedido nunca avançou por causa das tentativas negadas.
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.UNDER_REVIEW);
});

// ═══════════════════════════════════════════════════════════════════════
// 6) MANIPULAÇÃO DE order_id / payment_id / preço, ISOLAMENTO ENTRE CLIENTES
// ═══════════════════════════════════════════════════════════════════════

test('ORDER_ID ADVERSARIAL: inexistente, string maliciosa e negativo nunca crasham — erro claro em todos os casos', () => {
    const admin = makeUser('admin');
    for (const badId of [999999999, "1 OR 1=1", -1, 'null', 0]) {
        assert.throws(() => PaymentManager.confirmPayment(badId, admin));
        assert.throws(() => PaymentManager.rejectPayment(badId, admin, 'motivo'));
        assert.throws(() => PaymentManager.requestNewProof(badId, admin, 'motivo'));
    }
});

test('ESTRUTURAL: nenhuma função pública de PaymentManager aceita payment_id, price, amount ou valor como parâmetro', () => {
    const publicFunctions = Object.entries(PaymentManager).filter(([, v]) => typeof v === 'function');
    for (const [name, fn] of publicFunctions) {
        const signature = fn.toString().split('{')[0].split('=>')[0];
        assert.equal(/paymentId|payment_id/i.test(signature), false, `função pública "${name}" não deveria aceitar paymentId — sempre resolvido via orderId`);
        assert.equal(/\bprice\b|\bamount\b|\bvalor\b/i.test(signature), false, `função pública "${name}" não deveria aceitar preço/valor como parâmetro`);
    }
});

test('ESTRUTURAL: PaymentManager.js nunca escreve em users.max_bots/max_ram/max_cpu diretamente (capacidade é sempre via capacityManager, fora desta fase)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'managers', 'commerce', 'PaymentManager.js'), 'utf8');
    const directWrite = /UPDATE\s+users\s+SET[^;]*\bmax_(bots|ram|cpu)\s*=/is;
    assert.equal(directWrite.test(src), false);
});

test('SNAPSHOT PRESERVADO: o snapshot do produto e o preço final permanecem idênticos do início ao fim do ciclo de aprovação', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, admin);
    const snapshotBefore = order.product_snapshot;
    const priceBefore = order.total_price;

    PaymentManager.confirmPayment(order.id, admin);

    const after = OrderManager.getOrder(order.id);
    assert.equal(after.product_snapshot, snapshotBefore);
    assert.equal(after.total_price, priceBefore);
});

test('ISOLAMENTO ENTRE CLIENTES: aprovar o pedido do cliente A nunca afeta o pedido em revisão do cliente B', async () => {
    const admin = makeUser('admin');
    const clientA = makeUser();
    const clientB = makeUser();
    const orderA = await makeOrderUnderReview(clientA, admin);
    const orderB = await makeOrderUnderReview(clientB, admin);

    PaymentManager.confirmPayment(orderA.id, admin);

    const refreshedB = OrderManager.getOrder(orderB.id);
    assert.equal(refreshedB.status, OrderManager.STATUS.UNDER_REVIEW, 'o pedido do cliente B nunca deveria ter sido tocado');
    assert.equal(PaymentManager.getPaymentByOrder(orderB.id).status, 'awaiting_proof');
});

// ═══════════════════════════════════════════════════════════════════════
// 7) AUDITORIA — sem secrets, com staff/data/order_id/ação/motivo
// ═══════════════════════════════════════════════════════════════════════

test('AUDITORIA: pedir novo comprovante registra staff, order_id, ação e motivo — nunca dados sensíveis', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const order = await makeOrderUnderReview(client, admin);

    PaymentManager.requestNewProof(order.id, admin, 'comprovante com valor errado');

    const events = query("SELECT * FROM audit_log WHERE action = 'commerce:proof_reupload_requested'");
    const relevant = events.find((e) => JSON.parse(e.details).orderId === order.id);
    assert.ok(relevant);
    assert.equal(relevant.user_id, admin);
    assert.equal(JSON.parse(relevant.details).reason, 'comprovante com valor errado');
    assert.equal(/token|senha|password|secret/i.test(relevant.details), false);
});

test('AUDITORIA: aprovação e rejeição são auditadas com order_id e quem decidiu', async () => {
    const admin = makeUser('admin');
    const client1 = makeUser();
    const client2 = makeUser();
    const orderApproved = await makeOrderUnderReview(client1, admin);
    const orderRejected = await makeOrderUnderReview(client2, admin);

    PaymentManager.confirmPayment(orderApproved.id, admin);
    PaymentManager.rejectPayment(orderRejected.id, admin, 'motivo da recusa');

    const confirmedEvent = query("SELECT * FROM audit_log WHERE action = 'commerce:payment_confirmed'").find((e) => JSON.parse(e.details).orderId === orderApproved.id);
    const rejectedEvent = query("SELECT * FROM audit_log WHERE action = 'commerce:payment_rejected'").find((e) => JSON.parse(e.details).orderId === orderRejected.id);
    assert.ok(confirmedEvent && confirmedEvent.user_id === admin);
    assert.ok(rejectedEvent && rejectedEvent.user_id === admin && JSON.parse(rejectedEvent.details).reason === 'motivo da recusa');
});
