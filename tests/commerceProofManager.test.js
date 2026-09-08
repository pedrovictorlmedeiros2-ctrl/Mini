const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commerceProofManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get, query } = require('../src/database/database');
initDatabase();

const config = require('../config');
config.commerce.proofsFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-proofs-test-'));
config.commerce.maxProofSizeBytes = 1024 * 1024; // 1MB pros testes

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const CommerceStaffManager = require('../src/managers/commerce/CommerceStaffManager');
const ProofManager = require('../src/managers/commerce/ProofManager');

let counter = 0;
function makeUser(role = 'client') {
    counter += 1;
    const userId = `proof-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', role]);
    return userId;
}
function makeOrderAwaitingPayment(userId) {
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `proof-channel-${counter}` });
    const draftProduct = ProductCatalog.saveProduct({ id: `proof-prod-${counter}`, name: 'Plano', price: 29.9, maxBots: 2, maxRam: 512, maxCpu: 40 });
    const product = ProductCatalog.publishProduct(draftProduct.id);
    OrderManager.confirmProduct(order.id, product.id);
    return OrderManager.getOrder(order.id);
}

// Buffers reais mínimos com assinatura correta.
const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF_BUFFER = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('conteudo fake de pdf')]);
const EXE_BUFFER = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // assinatura MZ (executável Windows)

const originalFetch = global.fetch;
function mockFetch(buffer, { ok = true } = {}) {
    global.fetch = async () => ({
        ok,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    });
}
test.afterEach(() => {
    global.fetch = originalFetch;
});

test('submitProof: comprovante válido (PNG) é aceito, cifrado em repouso, e transiciona o pedido pra PROOF_SUBMITTED', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);

    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/x/y/comprovante.png', name: 'comprovante.png', contentType: 'image/png', size: PNG_BUFFER.length });

    assert.equal(proof.mime_type, 'image/png');
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.PROOF_SUBMITTED);

    // Arquivo em disco nunca é o conteúdo em texto puro.
    const onDisk = fs.readFileSync(proof.storage_path);
    assert.notEqual(onDisk.toString('latin1'), PNG_BUFFER.toString('latin1'));
    assert.equal(onDisk.includes(PNG_BUFFER), false, 'o buffer original nunca deveria aparecer cru dentro do arquivo cifrado');
});

test('IDOR: submitProof recusa um comprovante enviado por quem NÃO é dono do pedido', async () => {
    const owner = makeUser();
    const attacker = makeUser();
    const order = makeOrderAwaitingPayment(owner);
    mockFetch(PNG_BUFFER);

    await assert.rejects(
        () => ProofManager.submitProof(order.id, attacker, { url: 'x', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length }),
        /não é o dono deste pedido/
    );
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.AWAITING_PAYMENT, 'o pedido nunca deveria ter avançado de estado');
    assert.equal(query('SELECT * FROM commerce_proofs WHERE order_id = ?', [order.id]).length, 0);
});

test('IDOR: tentativa negada é auditada com o ID de quem tentou e o dono real', async () => {
    const owner = makeUser();
    const attacker = makeUser();
    const order = makeOrderAwaitingPayment(owner);

    await assert.rejects(() => ProofManager.submitProof(order.id, attacker, { url: 'x', name: 'a.png', size: 10 }));

    // Compara o orderId como CAMPO JSON parseado, nunca como substring
    // crua — dois pedidos com IDs numéricos "5" e "15" fariam uma busca
    // por substring encontrar a linha errada.
    const auditRows = query("SELECT * FROM audit_log WHERE action = 'commerce:proof_ownership_denied'");
    const relevant = auditRows.find((r) => JSON.parse(r.details).orderId === order.id);
    assert.ok(relevant, 'deveria existir um evento de auditoria pra essa tentativa negada');
    assert.equal(JSON.parse(relevant.details).actualOwnerId, owner);
});

test('TIPO REAL POR CONTEÚDO: um "comprovante.jpg" cujo conteúdo é na verdade um executável (MZ) é recusado', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(EXE_BUFFER);

    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'x', name: 'comprovante.jpg', contentType: 'image/jpeg', size: EXE_BUFFER.length }),
        /Tipo de arquivo não permitido/
    );
    assert.equal(query('SELECT * FROM commerce_proofs WHERE order_id = ?', [order.id]).length, 0);
});

test('TIPO REAL POR CONTEÚDO: extensão .png com conteúdo JPEG real é recusada (extensão não bate com o conteúdo)', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(JPEG_BUFFER);

    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'x', name: 'comprovante.png', contentType: 'image/jpeg', size: JPEG_BUFFER.length }),
        /extensão do arquivo não corresponde/
    );
});

test('TIPO REAL POR CONTEÚDO: MIME declarado divergente do conteúdo real é recusado, mesmo com extensão correta', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PDF_BUFFER);

    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'x', name: 'comprovante.pdf', contentType: 'image/png', size: PDF_BUFFER.length }),
        /tipo declarado do arquivo não corresponde/
    );
});

test('PDF válido também é aceito (allowlist não é só imagem)', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PDF_BUFFER);

    const proof = await ProofManager.submitProof(order.id, userId, { url: 'x', name: 'comprovante.pdf', contentType: 'application/pdf', size: PDF_BUFFER.length });
    assert.equal(proof.mime_type, 'application/pdf');
});

test('TAMANHO: arquivo maior que o limite configurado é recusado (checado antes E depois do download)', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    const hugeSize = config.commerce.maxProofSizeBytes + 1;

    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'x', name: 'a.png', contentType: 'image/png', size: hugeSize }),
        /muito grande/
    );
});

test('TAMANHO: tamanho declarado mentiroso (pequeno) não escapa da checagem — o tamanho REAL baixado também é validado', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    const bigBuffer = Buffer.concat([PNG_BUFFER, Buffer.alloc(config.commerce.maxProofSizeBytes)]);
    mockFetch(bigBuffer);

    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'x', name: 'a.png', contentType: 'image/png', size: 10 }), // mente que é pequeno
        /muito grande/
    );
});

test('submitProof: só aceito em AWAITING_PAYMENT ou PROOF_SUBMITTED — nunca em DRAFT/UNDER_REVIEW/etc.', async () => {
    const userId = makeUser();
    counter += 1;
    const draftOrder = OrderManager.createOrder({ userId, channelId: `proof-draft-${counter}` });
    mockFetch(PNG_BUFFER);

    await assert.rejects(
        () => ProofManager.submitProof(draftOrder.id, userId, { url: 'x', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length }),
        /não está aceitando comprovante/
    );
});

test('HISTÓRICO: reenviar um comprovante nunca sobrescreve o anterior — cria uma linha nova', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const first = await ProofManager.submitProof(order.id, userId, { url: 'x', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    mockFetch(JPEG_BUFFER);
    const second = await ProofManager.submitProof(order.id, userId, { url: 'y', name: 'b.jpg', contentType: 'image/jpeg', size: JPEG_BUFFER.length });

    assert.notEqual(first.id, second.id);
    const all = ProofManager.listProofsForOrder(order.id);
    assert.equal(all.length, 2);
    assert.ok(ProofManager.getProof(first.id), 'a primeira linha nunca deveria ser apagada');
});

test('getDecryptedProof: só staff comercial (admin ou COMMERCE_STAFF) — nunca o próprio cliente, nunca outro cliente', async () => {
    const admin = makeUser('admin');
    const owner = makeUser();
    const otherClient = makeUser();
    const order = makeOrderAwaitingPayment(owner);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, owner, { url: 'x', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    assert.throws(() => ProofManager.getDecryptedProof(proof.id, owner), /Sem permissão comercial/, 'nem o próprio dono do pedido pode decriptar sem ser staff');
    assert.throws(() => ProofManager.getDecryptedProof(proof.id, otherClient), /Sem permissão comercial/);

    const result = ProofManager.getDecryptedProof(proof.id, admin);
    assert.deepEqual(Buffer.compare(result.buffer, PNG_BUFFER), 0, 'staff deveria conseguir decriptar e obter o conteúdo original exato');
});

test('getDecryptedProof: COMMERCE_STAFF (sem ser admin) também pode visualizar', async () => {
    const admin = makeUser('admin');
    const staff = makeUser();
    CommerceStaffManager.grant(staff, admin);
    const owner = makeUser();
    const order = makeOrderAwaitingPayment(owner);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, owner, { url: 'x', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    assert.doesNotThrow(() => ProofManager.getDecryptedProof(proof.id, staff));
});

test('AUDITORIA: recebimento e visualização são ambos auditados', async () => {
    const admin = makeUser('admin');
    const owner = makeUser();
    const order = makeOrderAwaitingPayment(owner);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, owner, { url: 'x', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    const received = query("SELECT * FROM audit_log WHERE action = 'commerce:proof_received' AND details LIKE ?", [`%${proof.id}%`]);
    assert.equal(received.length, 1);

    ProofManager.getDecryptedProof(proof.id, admin);
    const viewed = query("SELECT * FROM audit_log WHERE action = 'commerce:proof_viewed' AND details LIKE ?", [`%${proof.id}%`]);
    assert.equal(viewed.length, 1);
    assert.equal(viewed[0].user_id, admin);
});

test('ISOLAMENTO: comprovante do pedido do cliente A nunca aparece na listagem do pedido do cliente B', async () => {
    const clientA = makeUser();
    const clientB = makeUser();
    const orderA = makeOrderAwaitingPayment(clientA);
    const orderB = makeOrderAwaitingPayment(clientB);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(orderA.id, clientA, { url: 'x', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    assert.equal(ProofManager.listProofsForOrder(orderB.id).length, 0);
    assert.equal(ProofManager.getLatestProofForOrder(orderB.id), null);
});

test('INTEGRIDADE: arquivo adulterado em disco faz getDecryptedProof falhar explicitamente (nunca devolve lixo silenciosamente)', async () => {
    const admin = makeUser('admin');
    const owner = makeUser();
    const order = makeOrderAwaitingPayment(owner);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, owner, { url: 'x', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    // Corrompe o arquivo cifrado em disco.
    const corrupted = fs.readFileSync(proof.storage_path);
    corrupted[corrupted.length - 1] ^= 0xff;
    fs.writeFileSync(proof.storage_path, corrupted);

    assert.throws(() => ProofManager.getDecryptedProof(proof.id, admin));
});
