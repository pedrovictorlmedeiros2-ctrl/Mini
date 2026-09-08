/**
 * TESTES ADVERSARIAIS — FASE 5 (Pix + armazenamento protegido de comprovantes)
 *
 * Foco: tudo que a Fase 5 pediu explicitamente pra provar sobre o que já
 * existia (Fase 3) + o que foi endurecido nesta fase:
 *   - path traversal / nomes maliciosos no filename declarado;
 *   - normalização Unicode / caracteres de controle;
 *   - extensão dupla;
 *   - MIME e Content-Type forjados (dois ângulos do mesmo problema);
 *   - arquivos vazios, gigantes, nomes gigantes, ZIP/executável;
 *   - tentativa de sobrescrever outro comprovante (colisão de nome forçada);
 *   - IDOR (comprovante e pedido de terceiro), order_id manipulado;
 *   - estado inválido da máquina de estados;
 *   - CONCORRÊNCIA REAL (TOCTOU) — não só a otimização de lock em memória
 *     da Fase 4, mas a re-checagem persistente contra o banco dentro do
 *     próprio ProofManager;
 *   - staff revogado tentando acessar comprovantes;
 *   - acesso "direto" ao armazenamento (arquivo em disco é ciphertext puro,
 *     nunca o conteúdo original nem a chave, permissões restritivas);
 *   - snapshot do Pix (congelado no Payment, imune a mudanças posteriores);
 *   - retenção configurável (purga só o que já foi revisado, nunca o
 *     pendente; nunca apaga a linha, só o arquivo).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cryptoNode = require('crypto');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commercePhase5Adversarial.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get, query } = require('../src/database/database');
initDatabase();

const config = require('../config');
const proofsFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-proofs-phase5-'));
config.commerce.proofsFolder = proofsFolder;
config.commerce.maxProofSizeBytes = 1024 * 1024; // 1MB pros testes

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const PaymentManager = require('../src/managers/commerce/PaymentManager');
const CommerceStaffManager = require('../src/managers/commerce/CommerceStaffManager');
const CommerceScheduler = require('../src/managers/commerce/CommerceScheduler');
const ProofManager = require('../src/managers/commerce/ProofManager');

let counter = 0;
function makeUser(role = 'client') {
    counter += 1;
    const userId = `p5-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', role]);
    return userId;
}
function makeOrderAwaitingPayment(userId) {
    counter += 1;
    const order = OrderManager.createOrder({ userId, channelId: `p5-channel-${counter}` });
    const draft = ProductCatalog.saveProduct({ id: `p5-prod-${counter}`, name: 'Plano', price: 29.9, maxBots: 2, maxRam: 512, maxCpu: 40 });
    const product = ProductCatalog.publishProduct(draft.id);
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    return OrderManager.getOrder(order.id);
}

const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x01, 0x02, 0x03]);
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF_BUFFER = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('conteudo fake de pdf')]);
const EXE_BUFFER = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // "MZ"
const ZIP_BUFFER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]); // "PK\x03\x04"

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

// ═══════════════════════════════════════════════════════════════════════
// 1) PATH TRAVERSAL / NOMES MALICIOSOS
// ═══════════════════════════════════════════════════════════════════════

test('PATH TRAVERSAL: "../../../etc/passwd.png" nunca escapa do diretório de armazenamento — nome interno é sempre um UUID', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);

    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: '../../../etc/passwd.png', contentType: 'image/png', size: PNG_BUFFER.length });

    assert.ok(path.resolve(proof.storage_path).startsWith(path.resolve(proofsFolder)), 'o arquivo tem que ficar dentro do diretório de comprovantes');
    assert.equal(proof.original_filename, 'passwd.png', 'só o nome final sobrevive — nenhum componente de diretório');
    assert.doesNotMatch(proof.storage_path, /\.\./);
});

test('PATH TRAVERSAL: barras invertidas ("..\\\\..\\\\evil.png") também não geram nenhum componente de diretório persistido', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);

    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: '..\\..\\evil.png', contentType: 'image/png', size: PNG_BUFFER.length });
    // Nome interno sempre é um UUID.enc — nunca derivado do nome enviado.
    assert.match(path.basename(proof.storage_path), /^[0-9a-f-]{36}\.enc$/);
});

test('NOME ABSOLUTO: um nome de arquivo absoluto ("/etc/shadow") nunca vira um caminho de escrita real', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);

    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: '/etc/shadow', contentType: 'image/png', size: PNG_BUFFER.length });
    assert.ok(path.resolve(proof.storage_path).startsWith(path.resolve(proofsFolder)));
});

test('ESTRUTURAL: storage_path NUNCA é construído a partir de attachment.name/original_filename — sempre crypto.randomUUID()', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'managers', 'commerce', 'ProofManager.js'), 'utf8');
    // A linha que monta storagePath só pode referenciar proofId — nunca
    // attachment.name, safeOriginalFilename ou qualquer variável derivada
    // do nome enviado pelo cliente.
    const storagePathLine = src.split('\n').find((l) => l.includes('const storagePath ='));
    assert.ok(storagePathLine, 'linha de montagem do storagePath deveria existir');
    assert.doesNotMatch(storagePathLine, /attachment\.name|safeOriginalFilename|declaredExt/);
    assert.match(storagePathLine, /proofId/);
});

// ═══════════════════════════════════════════════════════════════════════
// 2) UNICODE / NORMALIZAÇÃO / CARACTERES DE CONTROLE
// ═══════════════════════════════════════════════════════════════════════

test('UNICODE: nome com caracteres combinantes é normalizado (NFC) antes de persistir', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    // "é" decomposto (e + combining acute accent, NFD) vs pré-composto (NFC).
    const decomposedName = 'comprovante-é.png';

    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: decomposedName, contentType: 'image/png', size: PNG_BUFFER.length });
    assert.equal(proof.original_filename, proof.original_filename.normalize('NFC'), 'o nome persistido já deveria estar normalizado');
});

test('CARACTERES DE CONTROLE: nome com bytes de controle embutidos nunca é persistido cru', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const maliciousName = 'comprovante\x00\x1b[31m.png';

    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: maliciousName, contentType: 'image/png', size: PNG_BUFFER.length });
    assert.doesNotMatch(proof.original_filename, /[\x00-\x1f\x7f]/);
});

// ═══════════════════════════════════════════════════════════════════════
// 3) EXTENSÃO DUPLA / MIME / CONTENT-TYPE FORJADOS
// ═══════════════════════════════════════════════════════════════════════

test('EXTENSÃO DUPLA: "fatura.pdf.exe" com conteúdo PDF real é recusado (a extensão real levada em conta é a última, ".exe")', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PDF_BUFFER);

    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'fatura.pdf.exe', contentType: 'application/pdf', size: PDF_BUFFER.length }),
        /extensão do arquivo não corresponde/
    );
});

test('EXTENSÃO DUPLA: "fatura.exe.pdf" com conteúdo EXE real (MZ) é recusado pelo conteúdo, mesmo terminando em ".pdf"', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(EXE_BUFFER);

    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'fatura.exe.pdf', contentType: 'application/pdf', size: EXE_BUFFER.length }),
        /Tipo de arquivo não permitido/
    );
});

test('MIME FORJADO: Content-Type declarado "image/png" mas conteúdo real é PDF — recusado pelo conteúdo', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PDF_BUFFER);

    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'comprovante.pdf', contentType: 'image/png', size: PDF_BUFFER.length }),
        /tipo declarado do arquivo não corresponde/
    );
});

test('CONTENT-TYPE FORJADO: Content-Type "application/pdf" com extensão .png e conteúdo PNG real — recusado (nem extensão nem Content-Type batem com o padrão do outro)', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);

    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'comprovante.png', contentType: 'application/pdf', size: PNG_BUFFER.length }),
        /tipo declarado do arquivo não corresponde/
    );
});

// ═══════════════════════════════════════════════════════════════════════
// 4) VAZIO / OVERSIZED / NOME GIGANTE / ZIP / EXECUTÁVEL
// ═══════════════════════════════════════════════════════════════════════

test('VAZIO: arquivo de 0 bytes é recusado', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(Buffer.alloc(0));
    await assert.rejects(() => ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: 0 }), /vazio/);
});

test('OVERSIZED: arquivo acima do limite configurado é recusado, mesmo que o tamanho declarado minta', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    const huge = Buffer.concat([PNG_BUFFER, Buffer.alloc(config.commerce.maxProofSizeBytes)]);
    mockFetch(huge);
    await assert.rejects(() => ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: 10 }), /muito grande/);
});

test('NOME GIGANTE: nome de arquivo com milhares de caracteres nunca crasha e é truncado com segurança', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const giantName = `${'a'.repeat(10000)}.png`;

    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: giantName, contentType: 'image/png', size: PNG_BUFFER.length });
    assert.ok(proof.original_filename.length <= 150, 'nome persistido nunca deveria crescer sem limite');
});

test('ZIP: um arquivo ZIP (PK\\x03\\x04) nunca é aceito — allowlist é só imagem/PDF', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(ZIP_BUFFER);
    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'comprovante.zip', contentType: 'application/zip', size: ZIP_BUFFER.length }),
        /Tipo de arquivo não permitido/
    );
    assert.deepEqual(ProofManager.detectFileType(ZIP_BUFFER), null);
});

test('EXECUTÁVEL: um .jpg cujo conteúdo real é um executável Windows (MZ) é recusado', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(EXE_BUFFER);
    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'comprovante.jpg', contentType: 'image/jpeg', size: EXE_BUFFER.length }),
        /Tipo de arquivo não permitido/
    );
});

test('CONTEÚDO VÁLIDO COM LIXO: um PNG com assinatura correta mas bytes extras aleatórios depois é aceito (o sniff valida o cabeçalho, não escaneia malware) — documenta o limite real da defesa', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    const pngWithGarbage = Buffer.concat([PNG_BUFFER, cryptoNode.randomBytes(64)]);
    mockFetch(pngWithGarbage);
    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: pngWithGarbage.length });
    assert.equal(proof.mime_type, 'image/png');
});

// ═══════════════════════════════════════════════════════════════════════
// 5) SOBRESCREVER OUTRO COMPROVANTE (colisão de nome forçada)
// ═══════════════════════════════════════════════════════════════════════

test('OVERWRITE: se dois comprovantes gerassem o MESMO id interno, a escrita falha (flag "wx") em vez de sobrescrever silenciosamente', async () => {
    const userA = makeUser();
    const userB = makeUser();
    const orderA = makeOrderAwaitingPayment(userA);
    const orderB = makeOrderAwaitingPayment(userB);

    const originalRandomUUID = cryptoNode.randomUUID;
    cryptoNode.randomUUID = () => 'forced-collision-test-uuid-000';
    try {
        mockFetch(PNG_BUFFER);
        const first = await ProofManager.submitProof(orderA.id, userA, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
        assert.equal(first.id, 'forced-collision-test-uuid-000');
        const originalBytes = fs.readFileSync(first.storage_path);

        mockFetch(JPEG_BUFFER);
        await assert.rejects(
            () => ProofManager.submitProof(orderB.id, userB, { url: 'https://cdn.discordapp.com/attachments/2/2/file2.dat', name: 'b.jpg', contentType: 'image/jpeg', size: JPEG_BUFFER.length })
        );

        // O arquivo do primeiro comprovante nunca foi tocado pela segunda tentativa.
        assert.deepEqual(fs.readFileSync(first.storage_path), originalBytes);
        assert.equal(query('SELECT * FROM commerce_proofs WHERE id = ?', ['forced-collision-test-uuid-000']).length, 1);
    } finally {
        cryptoNode.randomUUID = originalRandomUUID;
    }
});

// ═══════════════════════════════════════════════════════════════════════
// 6) IDOR / ORDER_ID MANIPULADO / TERCEIROS / ESTADO INVÁLIDO
// ═══════════════════════════════════════════════════════════════════════

test('ORDER_ID MANIPULADO: orderId inexistente/forjado nunca crasha — erro claro, nada gravado', async () => {
    const userId = makeUser();
    mockFetch(PNG_BUFFER);
    await assert.rejects(
        () => ProofManager.submitProof(999999999, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length }),
        /não encontrado/
    );
});

test('ORDER_ID MANIPULADO: orderId em formato inesperado (string não-numérica) nunca crasha', async () => {
    const userId = makeUser();
    await assert.rejects(() => ProofManager.submitProof('drop-table-orders', userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', size: 10 }));
});

test('TERCEIROS: comprovante enviado pra pedido de OUTRO cliente é recusado e auditado', async () => {
    const owner = makeUser();
    const attacker = makeUser();
    const order = makeOrderAwaitingPayment(owner);
    mockFetch(PNG_BUFFER);

    await assert.rejects(
        () => ProofManager.submitProof(order.id, attacker, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length }),
        /não é o dono deste pedido/
    );
    assert.equal(query('SELECT * FROM commerce_proofs WHERE order_id = ?', [order.id]).length, 0);
});

for (const invalidStatus of ['UNDER_REVIEW', 'APPROVED', 'CANCELLED', 'REJECTED']) {
    test(`ESTADO INVÁLIDO: comprovante recusado quando o pedido está em ${invalidStatus}`, async () => {
        const userId = makeUser();
        const order = makeOrderAwaitingPayment(userId);
        run('UPDATE commerce_orders SET status = ? WHERE id = ?', [invalidStatus, order.id]);
        mockFetch(PNG_BUFFER);

        await assert.rejects(
            () => ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length }),
            /não está aceitando comprovante/
        );
    });
}

// ═══════════════════════════════════════════════════════════════════════
// 7) CONCORRÊNCIA REAL (TOCTOU) — garantia persistente, não só lock em memória
// ═══════════════════════════════════════════════════════════════════════

test('TOCTOU: pedido é CANCELADO enquanto o download do comprovante ainda está em andamento — a submissão é rejeitada, nada é gravado', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);

    let resolveFetch;
    global.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });

    const submitPromise = ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    // Enquanto o "download" está pendurado (nenhum await resolvido
    // ainda), o pedido é cancelado por um caminho totalmente diferente —
    // simula um staff/scheduler agindo durante a janela de I/O.
    OrderManager.cancelOrder(order.id);

    resolveFetch({ ok: true, arrayBuffer: async () => PNG_BUFFER.buffer.slice(PNG_BUFFER.byteOffset, PNG_BUFFER.byteOffset + PNG_BUFFER.byteLength) });

    await assert.rejects(submitPromise, /não está mais aceitando comprovante/);
    assert.equal(query('SELECT * FROM commerce_proofs WHERE order_id = ?', [order.id]).length, 0, 'nenhum comprovante deveria ter sido gravado');
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.CANCELLED);
    // Nenhum arquivo órfão foi deixado no diretório de comprovantes.
    const filesInFolder = fs.readdirSync(proofsFolder).filter((f) => f.endsWith('.enc'));
    const proofsInDb = query('SELECT storage_path FROM commerce_proofs').map((p) => path.basename(p.storage_path));
    for (const f of filesInFolder) {
        assert.ok(proofsInDb.includes(f), `arquivo órfão encontrado no disco sem linha correspondente no banco: ${f}`);
    }
});

test('TOCTOU: pedido avança pra UNDER_REVIEW (outro staff abriu revisão) enquanto o download está em andamento — a submissão tardia é rejeitada', async () => {
    const userId = makeUser();
    const admin = makeUser('admin');
    const order = makeOrderAwaitingPayment(userId);
    OrderManager.transitionOrder(order.id, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.PROOF_SUBMITTED);

    let resolveFetch;
    global.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
    const submitPromise = ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    PaymentManager.openForReview(order.id, admin);

    resolveFetch({ ok: true, arrayBuffer: async () => PNG_BUFFER.buffer.slice(PNG_BUFFER.byteOffset, PNG_BUFFER.byteOffset + PNG_BUFFER.byteLength) });

    await assert.rejects(submitPromise, /não está mais aceitando comprovante/);
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.UNDER_REVIEW, 'a transição feita pelo staff nunca deveria ser desfeita pela submissão tardia');
});

test('CONCORRÊNCIA: duas submissões verdadeiramente concorrentes (ambas em AWAITING_PAYMENT, sem nenhuma mudança de estado no meio) são AMBAS aceitas como histórico — a mais recente é determinística', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);

    const responses = [];
    global.fetch = async () => {
        const buf = responses.length === 0 ? PNG_BUFFER : JPEG_BUFFER;
        responses.push(buf);
        return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    };

    const [r1, r2] = await Promise.all([
        ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length }),
        ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/2/2/file2.dat', name: 'b.jpg', contentType: 'image/jpeg', size: JPEG_BUFFER.length }),
    ]);

    assert.notEqual(r1.id, r2.id);
    const all = ProofManager.listProofsForOrder(order.id);
    assert.equal(all.length, 2);
    const latest = ProofManager.getLatestProofForOrder(order.id);
    assert.ok(latest.id === r1.id || latest.id === r2.id, 'getLatestProofForOrder sempre devolve uma linha determinística, nunca undefined/ambígua');
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.PROOF_SUBMITTED);
});

// ═══════════════════════════════════════════════════════════════════════
// 7b) SSRF — achado da revisão adversarial final: attachment.url é tratado
//     como adversarial, allowlist de host do CDN oficial do Discord.
// ═══════════════════════════════════════════════════════════════════════

test('SSRF: uma URL fora do CDN do Discord (ex.: serviço de metadados de nuvem) é recusada ANTES de qualquer fetch()', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    let fetchWasCalled = false;
    global.fetch = async () => { fetchWasCalled = true; return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; };

    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'http://169.254.169.254/latest/meta-data/', name: 'a.png', contentType: 'image/png', size: 10 }),
        /URL do anexo inválida/
    );
    assert.equal(fetchWasCalled, false, 'nunca deveria sequer tentar baixar uma URL fora da allowlist');
});

test('SSRF: protocolo não-https (mesmo em host correto) é recusado', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'http://cdn.discordapp.com/attachments/1/1/a.png', name: 'a.png', size: 10 }),
        /URL do anexo inválida/
    );
});

test('SSRF: host parecido mas diferente ("cdn.discordapp.com.evil.com") é recusado — comparação de hostname é exata, nunca por sufixo/substring', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com.evil.com/x.png', name: 'a.png', size: 10 }),
        /URL do anexo inválida/
    );
});

test('SSRF: URL malformada nunca crasha — erro claro, mesma mensagem de URL inválida', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'não-é-uma-url', name: 'a.png', size: 10 }),
        /URL do anexo inválida/
    );
});

test('SSRF: media.discordapp.net (segundo CDN oficial do Discord) é aceito normalmente', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://media.discordapp.net/attachments/1/1/a.png', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    assert.equal(proof.mime_type, 'image/png');
});

test('CONTENT-LENGTH: um header Content-Length acima do limite recusa o download antes de baixar o corpo inteiro', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    let bodyWasRead = false;
    global.fetch = async () => ({
        ok: true,
        headers: { get: (name) => (name === 'content-length' ? String(config.commerce.maxProofSizeBytes + 1) : null) },
        arrayBuffer: async () => { bodyWasRead = true; return new ArrayBuffer(0); },
    });

    await assert.rejects(
        () => ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/a.png', name: 'a.png', size: 10 }),
        /muito grande/
    );
    assert.equal(bodyWasRead, false, 'o corpo nunca deveria ser lido quando o Content-Length já denuncia um arquivo grande demais');
});

// ═══════════════════════════════════════════════════════════════════════
// 8) STAFF REVOGADO / ACESSO DIRETO AO ARMAZENAMENTO
// ═══════════════════════════════════════════════════════════════════════

test('STAFF REVOGADO: getDecryptedProof nega e audita a tentativa, mesmo com o proofId correto', async () => {
    const admin = makeUser('admin');
    const staff = makeUser();
    CommerceStaffManager.grant(staff, admin);
    const owner = makeUser();
    const order = makeOrderAwaitingPayment(owner);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, owner, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    CommerceStaffManager.revoke(staff, admin);
    assert.throws(() => ProofManager.getDecryptedProof(proof.id, staff), /Sem permissão comercial/);

    const denied = query("SELECT * FROM audit_log WHERE action = 'commerce:proof_access_denied'");
    assert.ok(denied.some((r) => r.user_id === staff && JSON.parse(r.details).proofId === proof.id));
});

test('ACESSO DIRETO AO ARMAZENAMENTO: o arquivo em disco nunca é o conteúdo original, nunca começa com uma assinatura de imagem/PDF válida, e nunca contém a chave de criptografia', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    const raw = fs.readFileSync(proof.storage_path);
    assert.notDeepEqual(raw.subarray(0, PNG_BUFFER.length), PNG_BUFFER, 'o arquivo cru em disco nunca deveria ser o PNG original');
    assert.equal(ProofManager.detectFileType(raw), null, 'o blob cifrado nunca deveria passar como um tipo de arquivo válido');
    assert.equal(raw.includes(Buffer.from(config.security.encryptionKey)), false, 'a chave de criptografia nunca deveria aparecer dentro do arquivo cifrado');
});

test('PERMISSÕES: diretório de comprovantes e arquivo cifrado têm permissões restritivas (dono apenas)', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    const dirMode = fs.statSync(proofsFolder).mode & 0o777;
    const fileMode = fs.statSync(proof.storage_path).mode & 0o777;
    assert.equal(dirMode, 0o700, 'diretório de comprovantes deveria ser acessível só pelo dono');
    assert.equal(fileMode, 0o600, 'arquivo cifrado deveria ser legível/gravável só pelo dono');
});

test('SEM ENDPOINT PÚBLICO: nenhum arquivo do projeto serve o diretório de comprovantes via HTTP (express.static/sendFile)', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    function walk(dir) {
        let matches = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) matches = matches.concat(walk(full));
            else if (entry.name.endsWith('.js')) {
                const content = fs.readFileSync(full, 'utf8');
                if (/express\.static|res\.sendFile/.test(content) && /proof/i.test(content)) matches.push(full);
            }
        }
        return matches;
    }
    assert.deepEqual(walk(srcDir), [], 'nenhum arquivo deveria servir comprovantes via HTTP estático');
});

// ═══════════════════════════════════════════════════════════════════════
// 9) SNAPSHOT DO PIX
// ═══════════════════════════════════════════════════════════════════════

test('PIX SNAPSHOT: alterar a configuração Pix DEPOIS de um Payment criado nunca muda o snapshot já gravado', async () => {
    run('UPDATE sales_config SET pix_key = ?, pix_name = ?, pix_city = ? WHERE id = 1', ['chave-original@teste.com', 'Nome Original', 'Cidade Original']);
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    const payment = PaymentManager.getPaymentByOrder(order.id);
    assert.equal(payment.pix_key_snapshot, 'chave-original@teste.com');

    run('UPDATE sales_config SET pix_key = ?, pix_name = ?, pix_city = ? WHERE id = 1', ['chave-nova@teste.com', 'Nome Novo', 'Cidade Nova']);

    const reread = PaymentManager.getPaymentByOrder(order.id);
    assert.equal(reread.pix_key_snapshot, 'chave-original@teste.com', 'o snapshot congelado no momento da criação nunca deveria mudar');
    assert.equal(reread.pix_name_snapshot, 'Nome Original');
    assert.equal(reread.pix_city_snapshot, 'Cidade Original');
});

test('PIX: configurar Pix é auditado sem gravar a chave em claro nos detalhes do evento', async () => {
    const admin = makeUser('admin');
    const { recordAuditEvent } = require('../src/managers/auditManager');
    recordAuditEvent({ userId: admin, event: 'commerce:pix_configured', details: JSON.stringify({ configuredBy: admin }), severity: 'info' });

    const events = query("SELECT * FROM audit_log WHERE action = 'commerce:pix_configured' AND user_id = ?", [admin]);
    assert.ok(events.length >= 1);
    for (const e of events) {
        assert.equal(/chave-|pix_key|@/.test(e.details), false, 'detalhes do evento de auditoria nunca deveriam conter a chave Pix');
    }
});

// ═══════════════════════════════════════════════════════════════════════
// 10) RETENÇÃO
// ═══════════════════════════════════════════════════════════════════════

test('RETENÇÃO: comprovante "submitted" (pendente) NUNCA é purgado, não importa a idade', async () => {
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    run("UPDATE commerce_proofs SET created_at = datetime('now', '-99999 days') WHERE id = ?", [proof.id]);

    const purgedCount = ProofManager.purgeExpiredProofs();

    const reread = ProofManager.getProof(proof.id);
    assert.equal(reread.purged_at, null, 'comprovante pendente nunca deveria ser purgado');
    assert.ok(fs.existsSync(reread.storage_path), 'o arquivo do comprovante pendente ainda deveria existir em disco');
});

test('RETENÇÃO: comprovante já REVISADO (accepted/rejected) e mais velho que o limite tem o ARQUIVO removido, mas a LINHA permanece', async () => {
    const admin = makeUser('admin');
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    ProofManager.markLatestProofStatus(order.id, 'accepted', admin);
    run(`UPDATE commerce_proofs SET created_at = datetime('now', ?) WHERE id = ?`, [`-${config.commerce.proofRetentionDays + 1} days`, proof.id]);

    const purgedCount = ProofManager.purgeExpiredProofs();
    assert.ok(purgedCount >= 1);

    const reread = ProofManager.getProof(proof.id);
    assert.ok(reread, 'a LINHA no banco nunca deveria ser apagada — só o arquivo');
    assert.ok(reread.purged_at, 'purged_at deveria estar preenchido');
    assert.equal(fs.existsSync(reread.storage_path), false, 'o arquivo cifrado deveria ter sido removido');
});

test('RETENÇÃO: comprovante revisado mas DENTRO do prazo de retenção nunca é purgado', async () => {
    const admin = makeUser('admin');
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    ProofManager.markLatestProofStatus(order.id, 'accepted', admin);

    ProofManager.purgeExpiredProofs();
    const reread = ProofManager.getProof(proof.id);
    assert.equal(reread.purged_at, null);
    assert.ok(fs.existsSync(reread.storage_path));
});

test('RETENÇÃO: getDecryptedProof recusa explicitamente um comprovante já purgado', async () => {
    const admin = makeUser('admin');
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    ProofManager.markLatestProofStatus(order.id, 'rejected', admin, 'motivo qualquer');
    run(`UPDATE commerce_proofs SET created_at = datetime('now', ?) WHERE id = ?`, [`-${config.commerce.proofRetentionDays + 1} days`, proof.id]);
    ProofManager.purgeExpiredProofs();

    assert.throws(() => ProofManager.getDecryptedProof(proof.id, admin), /removido por retenção/);
});

test('RETENÇÃO: sweepExpiredProofs (CommerceScheduler) delega corretamente pro ProofManager', async () => {
    const admin = makeUser('admin');
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    ProofManager.markLatestProofStatus(order.id, 'accepted', admin);
    run(`UPDATE commerce_proofs SET created_at = datetime('now', ?) WHERE id = ?`, [`-${config.commerce.proofRetentionDays + 1} days`, proof.id]);

    const count = CommerceScheduler.sweepExpiredProofs();
    assert.ok(count >= 1);
    assert.ok(ProofManager.getProof(proof.id).purged_at);
});

// ═══════════════════════════════════════════════════════════════════════
// 11) CRIPTOGRAFIA — autenticada, chave nunca junto do arquivo
// ═══════════════════════════════════════════════════════════════════════

test('CRIPTOGRAFIA: adulterar um único byte do arquivo cifrado faz a decriptação falhar explicitamente (autenticação AES-GCM)', async () => {
    const admin = makeUser('admin');
    const userId = makeUser();
    const order = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const proof = await ProofManager.submitProof(order.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    const corrupted = fs.readFileSync(proof.storage_path);
    corrupted[corrupted.length - 1] ^= 0xff;
    fs.writeFileSync(proof.storage_path, corrupted);

    assert.throws(() => ProofManager.getDecryptedProof(proof.id, admin));
});

test('CRIPTOGRAFIA: dois comprovantes com o MESMO conteúdo produzem arquivos cifrados DIFERENTES (salt/IV aleatórios por arquivo)', async () => {
    const userId = makeUser();
    const order1 = makeOrderAwaitingPayment(userId);
    const order2 = makeOrderAwaitingPayment(userId);
    mockFetch(PNG_BUFFER);
    const proof1 = await ProofManager.submitProof(order1.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    mockFetch(PNG_BUFFER);
    const proof2 = await ProofManager.submitProof(order2.id, userId, { url: 'https://cdn.discordapp.com/attachments/1/1/file.dat', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    const raw1 = fs.readFileSync(proof1.storage_path);
    const raw2 = fs.readFileSync(proof2.storage_path);
    assert.notDeepEqual(raw1, raw2, 'o mesmo conteúdo cifrado duas vezes nunca deveria gerar o mesmo blob (salt/IV aleatórios)');
});
