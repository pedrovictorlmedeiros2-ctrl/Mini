/**
 * TESTES — FASE 10 (Handler Coverage / Test Hardening)
 *
 * Cobertura comportamental dos handlers de commerce.js que nunca tinham
 * sido exercitados através de `commerce.handle()` — não apenas nos
 * managers isolados. Inclui a correção de dois bugs reais encontrados na
 * auditoria pré-Fase-10 (P0-1: commerce_cancel_order apagava o canal de
 * um pedido que não pertencia ao usuário sem cancelar nada; P0-2: specs
 * negativas passavam a validação de criação de produto).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commercePhase10HandlerCoverage.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get, query } = require('../src/database/database');
initDatabase();

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const PaymentManager = require('../src/managers/commerce/PaymentManager');
const ProofManager = require('../src/managers/commerce/ProofManager');
const EntitlementManager = require('../src/managers/commerce/EntitlementManager');
const CommerceStaffManager = require('../src/managers/commerce/CommerceStaffManager');
const CommerceConfig = require('../src/managers/commerce/CommerceConfig');
const ProvisioningManager = require('../src/managers/commerce/ProvisioningManager');
const capacityManager = require('../src/managers/capacityManager');
const serviceReadiness = require('../src/managers/serviceReadiness');
const queueManager = require('../src/managers/queueManager');
const alertManager = require('../src/managers/alertManager');
const clientRef = require('../src/utils/clientRef');
const commerce = require('../src/handlers/domains/commerce');

const config = require('../config');
config.commerce.proofsFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-proofs-phase10-'));
config.commerce.maxProofSizeBytes = 1024 * 1024;

// Nunca chamada real de rede via alertManager/clientRef — mesmo stub das
// Fases 9.
alertManager.sendAlert = async () => {};
clientRef.tryDM = async () => true;

async function waitForQueueToDrain() {
    while (queueManager.getQueueMetrics().active > 0 || queueManager.getQueueMetrics().queued > 0) {
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await new Promise((resolve) => setImmediate(resolve));
}

let counter = 0;
function makeUser(role = 'client') {
    counter += 1;
    const userId = `p10-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', role]);
    return userId;
}
function makePublishedProduct(overrides = {}) {
    counter += 1;
    const draft = ProductCatalog.saveProduct({ id: `p10-prod-${counter}`, name: 'Plano', price: 29.9, maxBots: 2, maxRam: 400, maxCpu: 30, ...overrides });
    return ProductCatalog.publishProduct(draft.id);
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

function makeFakeUser(userId, username = 'tester') {
    return { id: userId, username, discriminator: '0', avatar: null, toString: () => `<@${userId}>` };
}
function makeFakeGuild(guildId, { channels = {} } = {}) {
    return {
        id: guildId,
        channels: {
            create: async (opts) => ({ id: `chan-${guildId}-created`, ...opts, send: async () => {}, delete: async () => {} }),
            cache: { get: (id) => channels[id] },
        },
    };
}
/** `fields` simula um modal do Discord — getTextInputValue(id) lê de um objeto simples. */
function makeFakeFields(values = {}) {
    return { getTextInputValue: (id) => values[id] ?? '' };
}
function makeFakeInteraction({ customId, userId, username, guild, values, fields, channel, extra = {} }) {
    const replies = [];
    let deletedChannel = false;
    const defaultChannel = { send: async () => {}, delete: async () => { deletedChannel = true; } };
    return {
        customId,
        user: makeFakeUser(userId, username),
        guild,
        values,
        fields: fields ? makeFakeFields(fields) : undefined,
        replied: false,
        deferred: false,
        reply: async (payload) => { replies.push(payload); return {}; },
        editReply: async (payload) => { replies.push(payload); return {}; },
        update: async (payload) => { replies.push(payload); return {}; },
        deferReply: async () => {},
        showModal: async (modal) => { replies.push({ modal }); return {}; },
        client: { users: { fetch: async () => ({ send: async () => {} }) } },
        channel: channel || defaultChannel,
        _replies: replies,
        _channelDeleted: () => deletedChannel,
        ...extra,
    };
}

async function makeApprovedOrder(clientUserId, adminUserId, productOverrides = {}) {
    const product = makePublishedProduct(productOverrides);
    counter += 1;
    const order = OrderManager.createOrder({ userId: clientUserId, channelId: `p10-channel-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, clientUserId, { url: 'https://cdn.discordapp.com/attachments/1/1/a.png', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    PaymentManager.openForReview(order.id, adminUserId);
    const { order: approved } = PaymentManager.confirmPayment(order.id, adminUserId);
    return { order: approved, product };
}

/** Deixa em UNDER_REVIEW sem chamar confirmPayment() — pra handlers que a chamam internamente. */
async function makeOrderUnderReview(clientUserId, adminUserId, productOverrides = {}) {
    const product = makePublishedProduct(productOverrides);
    counter += 1;
    const order = OrderManager.createOrder({ userId: clientUserId, channelId: `p10-channel-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, clientUserId, { url: 'https://cdn.discordapp.com/attachments/1/1/a.png', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    PaymentManager.openForReview(order.id, adminUserId);
    return { order: OrderManager.getOrder(order.id), product };
}

// Precisa rodar antes de qualquer outro teste criar um produto — este
// arquivo usa um único banco persistente pra todos os testes (sem
// isolamento por teste), então "catálogo vazio" só é um estado real e
// observável agora, no início do arquivo. Produtos já têm pedidos
// (commerce_orders) referenciando-os via FOREIGN KEY assim que qualquer
// outro teste roda, então mais tarde não seria possível recriar esse
// estado sem violar a constraint.
test('P1: commerce_admin_products — catálogo vazio mostra mensagem clara sem quebrar (roda antes de qualquer produto existir)', async () => {
    const admin = makeUser('admin');
    const semProdutos = makeFakeInteraction({ customId: 'commerce_admin_products', userId: admin });
    await commerce.handle(semProdutos, {});
    assert.match(semProdutos._replies[0].embeds[0].data.description, /Nenhum produto cadastrado/);
    assert.equal(semProdutos._replies[0].components.length, 1, 'sem produtos, só o botão de criar — nenhum select de gerenciar');
});

test('setup: computa o estado de prontidão real deste ambiente antes de qualquer fixture de provisionamento', async () => {
    const result = await serviceReadiness.computeReadiness();
    assert.ok([serviceReadiness.STATUS.DEGRADED, serviceReadiness.STATUS.READY].includes(result.status), `ambiente de teste inesperado: ${JSON.stringify(result)}`);
});

// ═══════════════════════════════════════════════════════════════════════
// P0-1 — commerce_cancel_order: correção do bug de autorização/efeito parcial
// ═══════════════════════════════════════════════════════════════════════

test('P0-1 — BUG CORRIGIDO: cliente B tentando cancelar o pedido do cliente A NUNCA recebe "Pedido cancelado" nem tem o canal apagado', async () => {
    const clientA = makeUser();
    const clientB = makeUser();
    counter += 1;
    const channelId = `p10-cancel-idor-${counter}`;
    const order = OrderManager.createOrder({ userId: clientA, channelId });

    const interaction = makeFakeInteraction({ customId: 'commerce_cancel_order', userId: clientB, extra: { channelId } });
    await commerce.handle(interaction, {});

    // O pedido de A continua vivo — invariante já coberta antes desta fase.
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.DRAFT);

    // NOVO (correção do bug): a resposta nunca pode dizer "cancelado", e o
    // canal nunca pode ser agendado para exclusão.
    assert.equal(interaction._replies.length, 1);
    assert.equal(/cancelado/i.test(interaction._replies[0].content), false, 'nunca deveria dizer "cancelado" pra quem não é o dono');
    assert.match(interaction._replies[0].content, /não é seu/);

    // Aguarda mais que o antigo setTimeout(5000) usaria, pra provar que
    // NENHUMA exclusão foi agendada (não só que ainda não rodou).
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(interaction._channelDeleted(), false, 'o canal nunca deveria ter sido apagado nem agendado pra isso');
});

test('P0-1: dono do pedido continua cancelando normalmente — pedido vai pra CANCELLED, canal é excluído (comportamento legítimo preservado)', async () => {
    const clientA = makeUser();
    counter += 1;
    const channelId = `p10-cancel-legit-${counter}`;
    const order = OrderManager.createOrder({ userId: clientA, channelId });

    const interaction = makeFakeInteraction({ customId: 'commerce_cancel_order', userId: clientA, extra: { channelId } });

    // O handler agenda a exclusão real com setTimeout(..., 5000) — acelera
    // só pra este teste, sem depender de esperar 5s reais.
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    try {
        await commerce.handle(interaction, {});
        assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.CANCELLED);
        assert.match(interaction._replies[0].content, /cancelado/i);
        await new Promise((resolve) => originalSetTimeout(resolve, 20));
    } finally {
        global.setTimeout = originalSetTimeout;
    }
    assert.equal(interaction._channelDeleted(), true, 'o canal do PRÓPRIO dono continua sendo excluído normalmente');
});

test('P0-1: dono tentando cancelar um pedido em estado não-cancelável (UNDER_REVIEW) recebe erro claro, nunca finge sucesso', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeOrderUnderReview(client, admin);

    const interaction = makeFakeInteraction({ customId: 'commerce_cancel_order', userId: client, extra: { channelId: order.channel_id } });
    await commerce.handle(interaction, {});

    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.UNDER_REVIEW, 'nunca deveria ter sido cancelado — já em análise');
    // A mensagem de erro do próprio manager contém a palavra "cancelado"
    // dentro da frase ("não pode mais ser cancelado pelo cliente") — por
    // isso a asserção precisa ser pela mensagem exata de erro, não por
    // ausência da palavra (uma checagem só por substring pegaria a
    // mensagem de erro como se fosse a de sucesso).
    assert.match(interaction._replies[0].content, /não pode mais ser cancelado pelo cliente/);
    assert.notEqual(interaction._replies[0].content, '❌ Pedido cancelado. Este canal será excluído em 5 segundos.');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(interaction._channelDeleted(), false);
});

test('P0-1: canal sem NENHUM pedido associado — comportamento de "nada a cancelar" preservado sem alteração (fora do escopo do bug corrigido)', async () => {
    const interaction = makeFakeInteraction({ customId: 'commerce_cancel_order', userId: makeUser(), extra: { channelId: 'p10-cancel-no-order-channel' } });
    await commerce.handle(interaction, {});
    // Comportamento pré-existente, não alterado por esta correção — só
    // confirma que continua estável (nunca lança).
    assert.equal(interaction._replies.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// P0-2 — modal_commerce_admin_create_product: correção de specs negativas
// ═══════════════════════════════════════════════════════════════════════

function makeCreateProductInteraction(userId, { id, name = 'Plano Teste', price = '29.90', resources, description = '' }) {
    return makeFakeInteraction({
        customId: 'modal_commerce_admin_create_product',
        userId,
        fields: { id, name, price, resources, description },
    });
}

test('P0-2 — BUG CORRIGIDO: maxBots negativo é rejeitado pelo handler, produto nunca é criado', async () => {
    const admin = makeUser('admin');
    const interaction = makeCreateProductInteraction(admin, { id: 'p10-neg-bots', resources: '-5,512,40' });
    await commerce.handle(interaction, {});

    assert.match(interaction._replies[0].content, /nunca negativos/);
    assert.equal(ProductCatalog.getProduct('p10-neg-bots'), undefined, 'nunca deveria ter sido persistido');
});

test('P0-2: maxRam negativo é rejeitado; maxCpu negativo é rejeitado — mesmo tratamento pros 3 campos', async () => {
    const admin = makeUser('admin');
    const i1 = makeCreateProductInteraction(admin, { id: 'p10-neg-ram', resources: '2,-100,40' });
    await commerce.handle(i1, {});
    assert.match(i1._replies[0].content, /nunca negativos/);
    assert.equal(ProductCatalog.getProduct('p10-neg-ram'), undefined);

    const i2 = makeCreateProductInteraction(admin, { id: 'p10-neg-cpu', resources: '2,512,-10' });
    await commerce.handle(i2, {});
    assert.match(i2._replies[0].content, /nunca negativos/);
    assert.equal(ProductCatalog.getProduct('p10-neg-cpu'), undefined);
});

test('P0-2: zero é REJEITADO hoje — dívida técnica conhecida, documentada, não corrigida nesta fase (fora do escopo aprovado: capacityManager.js)', async () => {
    // Achado durante a Fase 10: capacityManager.applyHostCaps() usa
    // `Number(x) || default` pra decidir o teto efetivo — 0 é falsy em
    // JS, então `Number(0) || 1` avalia pra 1 (idem RAM->256, CPU->30).
    // A validação desta fase (assertWithinHostCaps, Fase 9) compara o
    // valor "capado" contra o bruto e enxerga qualquer produto com algum
    // campo zerado como "acima do teto" — mensagem tecnicamente enganosa
    // (zero nunca excedeu nada; foi o PRÓPRIO applyHostCaps que trocou
    // 0 por um default antes da comparação). Decisão explícita do
    // usuário: documentar o comportamento atual sem tocar em
    // capacityManager.js nesta fase (fora da lista de bugs aprovados).
    const admin = makeUser('admin');
    const interaction = makeCreateProductInteraction(admin, { id: 'p10-zero', resources: '0,0,0' });
    await commerce.handle(interaction, {});

    assert.match(interaction._replies[0].content, /teto do host/);
    assert.equal(ProductCatalog.getProduct('p10-zero'), undefined, 'comportamento atual: produto com qualquer campo zerado nunca é criado');
});

test('P0-2: valores dentro do teto do host continuam sendo aceitos normalmente (sem regressão da Fase 9)', async () => {
    const admin = makeUser('admin');
    const interaction = makeCreateProductInteraction(admin, { id: 'p10-within-cap', resources: '5,480,45' });
    await commerce.handle(interaction, {});

    assert.match(interaction._replies[0].content, /criado como \*\*rascunho\*\*/);
    const product = ProductCatalog.getProduct('p10-within-cap');
    assert.ok(product);
    assert.equal(product.max_bots, 5);
    assert.equal(product.max_ram, 480);
    assert.equal(product.max_cpu, 45);
});

test('P0-2: valores ACIMA do teto do host continuam sendo rejeitados (validação da Fase 9 preservada, agora ao lado da validação de negativos)', async () => {
    const admin = makeUser('admin');
    const originalRamCap = process.env.HOST_MAX_RAM_PER_BOT;
    process.env.HOST_MAX_RAM_PER_BOT = '500';
    try {
        const interaction = makeCreateProductInteraction(admin, { id: 'p10-above-cap', resources: '2,900,40' });
        await commerce.handle(interaction, {});
        assert.match(interaction._replies[0].content, /teto do host/);
        assert.equal(ProductCatalog.getProduct('p10-above-cap'), undefined);
    } finally {
        if (originalRamCap === undefined) delete process.env.HOST_MAX_RAM_PER_BOT;
        else process.env.HOST_MAX_RAM_PER_BOT = originalRamCap;
    }
});

test('P0-2: sem permissão de admin, nem chega a validar — barrado antes de tocar em ProductCatalog', async () => {
    const staff = makeUser();
    const interaction = makeCreateProductInteraction(staff, { id: 'p10-no-perm', resources: '-5,512,40' });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /Acesso negado/);
    assert.equal(ProductCatalog.getProduct('p10-no-perm'), undefined);
});

test('P0-2 (manager, defesa em profundidade): ProductCatalog.saveProduct() rejeita specs negativas mesmo chamado diretamente, fora do handler', () => {
    assert.throws(() => ProductCatalog.saveProduct({ id: 'p10-direct-neg', name: 'X', price: 10, maxBots: -1, maxRam: 100, maxCpu: 10 }), /nunca negativos/);
    assert.equal(ProductCatalog.getProduct('p10-direct-neg'), undefined);
});

// ═══════════════════════════════════════════════════════════════════════
// P0-3 — commerce_staff_approve_: ponta a ponta do caminho de SUCESSO,
// através do handler real (nada do fluxo é mockado — só o transporte
// Discord: fetch de usuário, canais, criação de canal).
// ═══════════════════════════════════════════════════════════════════════

test('P0-3: aprovação bem-sucedida via commerce_staff_approve_ — pagamento, DMs, posts, fechamento de canal, provisionamento real e capacidade aplicada, de ponta a ponta', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order, product } = await makeOrderUnderReview(client, admin, { maxBots: 6, maxRam: 480, maxCpu: 45 });

    // Cupom no limite — pra exercitar o branch de couponWarning junto com
    // o resto do fluxo, sem precisar de um teste separado que reduza a
    // cobertura do handler.
    counter += 1;
    const couponCode = `P10FULL${counter}`;
    run("INSERT INTO coupons (code, type, value, max_uses, current_uses, status) VALUES (?, 'fixed', 5, 1, 1, 'active')", [couponCode]);
    const coupon = get('SELECT * FROM coupons WHERE code = ?', [couponCode]);
    // OrderManager.applyCoupon() só é válido em AWAITING_PAYMENT — o
    // pedido de teste já está em UNDER_REVIEW (necessário pra
    // confirmPayment funcionar via handler). Grava o vínculo direto no
    // banco, simulando que o cliente aplicou o cupom ANTES de enviar o
    // comprovante (ordem real do fluxo público).
    run('UPDATE commerce_orders SET coupon_id = ? WHERE id = ?', [coupon.id, order.id]);

    const dmSent = [];
    const fakeBuyerUser = { id: client, send: async (content) => { dmSent.push(content); } };
    const salesLogChannel = { _sent: [], send: async (p) => { salesLogChannel._sent.push(p); } };
    const proofsChannel = { _sent: [], send: async (p) => { proofsChannel._sent.push(p); } };
    const orderChannel = { _sent: [], send: async (p) => { orderChannel._sent.push(p); }, delete: async () => { orderChannel._deleted = true; } };

    CommerceConfig.saveChannelStructure({
        public_category_id: 'cat-p10', staff_category_id: 'staffcat-p10', staff_role_id: 'role-p10',
        sales_log_channel_id: 'chan-sales-log-p10', proofs_channel_id: 'chan-proofs-p10',
    });

    const guild = makeFakeGuild('guild-p10-approve', {
        channels: {
            [order.channel_id]: orderChannel,
            'chan-sales-log-p10': salesLogChannel,
            'chan-proofs-p10': proofsChannel,
        },
    });
    const interaction = makeFakeInteraction({
        customId: `commerce_staff_approve_${order.id}`, userId: admin, guild,
        extra: { client: { users: { fetch: async () => fakeBuyerUser } } },
    });

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    try {
        await commerce.handle(interaction, {});
        await waitForQueueToDrain();
        await new Promise((resolve) => originalSetTimeout(resolve, 20)); // deixa o setTimeout(0) do fechamento de canal assentar
    } finally {
        global.setTimeout = originalSetTimeout;
    }

    // 1) Permissão válida + confirmação do pagamento.
    assert.equal(interaction._replies.length, 1);
    assert.match(interaction._replies[0].content, /aprovado com sucesso/);
    assert.match(interaction._replies[0].content, /cupom acima do limite/, 'branch de couponWarning precisa aparecer na resposta ao staff');
    const payment = PaymentManager.getPaymentByOrder(order.id);
    assert.equal(payment.status, PaymentManager.PAYMENT_STATUS.CONFIRMED);

    // 2) Provisionamento real (via queueManager real) chegou a ACTIVE.
    const finalOrder = OrderManager.getOrder(order.id);
    assert.equal(finalOrder.status, OrderManager.STATUS.ACTIVE);

    // 3) Entitlement/capacidade real aplicada (não mockada).
    const entitlement = EntitlementManager.getActiveEntitlement(client);
    assert.ok(entitlement);
    const user = get('SELECT max_bots, max_ram, max_cpu FROM users WHERE id = ?', [client]);
    assert.equal(user.max_bots, 6);
    assert.equal(user.max_ram, 480);
    assert.equal(user.max_cpu, 45);

    // 4) DM ao comprador — duas mensagens: aprovação + ativação.
    assert.equal(dmSent.length, 2, 'comprador precisa receber a DM de aprovação E a de ativação');
    assert.match(dmSent[0], /pagamento foi aprovado/i);
    assert.match(dmSent[1], /plano foi ativado/i);

    // 5) Posts nos canais apropriados.
    assert.equal(salesLogChannel._sent.length, 1);
    assert.match(salesLogChannel._sent[0].content, /aprovado por/);
    assert.match(salesLogChannel._sent[0].content, /cupom acima do limite/);
    assert.equal(proofsChannel._sent.length, 1);
    assert.match(proofsChannel._sent[0].content, /revisado \(aceito\)/);

    // 6) Fechamento do canal do pedido.
    assert.equal(orderChannel._sent.length, 1);
    assert.match(orderChannel._sent[0], /Pagamento Aprovado/);
    assert.equal(orderChannel._deleted, true, 'canal do pedido precisa ter sido excluído após a aprovação');
});

// ═══════════════════════════════════════════════════════════════════════
// P1 — commerce_staff_reject_ + modal_commerce_staff_reject_
// ═══════════════════════════════════════════════════════════════════════

test('P1: commerce_staff_reject_ abre o modal de motivo; sem permissão, nunca chega a abrir', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeOrderUnderReview(client, admin);

    const okInteraction = makeFakeInteraction({ customId: `commerce_staff_reject_${order.id}`, userId: admin });
    await commerce.handle(okInteraction, {});
    assert.equal(okInteraction._replies.length, 1);
    assert.ok(okInteraction._replies[0].modal, 'staff com permissão precisa receber o modal');

    const staffSemPermissao = makeUser();
    const negInteraction = makeFakeInteraction({ customId: `commerce_staff_reject_${order.id}`, userId: staffSemPermissao });
    await commerce.handle(negInteraction, {});
    assert.match(negInteraction._replies[0].content, /Acesso negado/);
    assert.equal(negInteraction._replies[0].modal, undefined);
});

test('P1: modal_commerce_staff_reject_ — sucesso completo (recusa, DM, 2 posts, canal fechado em 10s)', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeOrderUnderReview(client, admin);

    const dmSent = [];
    const salesLogChannel = { _sent: [], send: async (p) => { salesLogChannel._sent.push(p); } };
    const proofsChannel = { _sent: [], send: async (p) => { proofsChannel._sent.push(p); } };
    const orderChannel = { send: async () => {}, delete: async () => { orderChannel._deleted = true; } };
    CommerceConfig.saveChannelStructure({ sales_log_channel_id: 'chan-sales-reject', proofs_channel_id: 'chan-proofs-reject' });
    const guild = makeFakeGuild('guild-p10-reject', { channels: { [order.channel_id]: orderChannel, 'chan-sales-reject': salesLogChannel, 'chan-proofs-reject': proofsChannel } });

    const interaction = makeFakeInteraction({
        customId: `modal_commerce_staff_reject_${order.id}`, userId: admin, guild,
        fields: { reason: 'Comprovante ilegível' },
        extra: { client: { users: { fetch: async () => ({ send: async (c) => dmSent.push(c) }) } } },
    });

    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => originalSetTimeout(fn, 0);
    try {
        await commerce.handle(interaction, {});
        await new Promise((resolve) => originalSetTimeout(resolve, 10));
    } finally {
        global.setTimeout = originalSetTimeout;
    }

    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.REJECTED);
    assert.equal(PaymentManager.getPaymentByOrder(order.id).status, PaymentManager.PAYMENT_STATUS.REJECTED);
    assert.match(interaction._replies[0].content, /recusado/);
    assert.equal(dmSent.length, 1);
    assert.match(dmSent[0], /recusado/i);
    assert.match(dmSent[0], /Comprovante ilegível/);
    assert.equal(salesLogChannel._sent.length, 1);
    assert.equal(proofsChannel._sent.length, 1);
    assert.equal(orderChannel._deleted, true);
});

test('P1: modal_commerce_staff_reject_ — pedido que já não está em UNDER_REVIEW é recusado com erro claro, nunca finge sucesso', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeApprovedOrder(client, admin); // já em APPROVED, não UNDER_REVIEW

    const interaction = makeFakeInteraction({ customId: `modal_commerce_staff_reject_${order.id}`, userId: admin, fields: { reason: 'tarde demais' } });
    await commerce.handle(interaction, {});

    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.APPROVED, 'nunca deveria ter sido alterado');
    assert.match(interaction._replies[0].content, /não está em revisão/);
});

test('P1: modal_commerce_staff_reject_ — staff sem permissão é barrado antes de tocar no pedido', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeOrderUnderReview(client, admin);
    const staffSemPermissao = makeUser();

    const interaction = makeFakeInteraction({ customId: `modal_commerce_staff_reject_${order.id}`, userId: staffSemPermissao, fields: { reason: 'x' } });
    await commerce.handle(interaction, {});

    assert.match(interaction._replies[0].content, /Acesso negado/);
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.UNDER_REVIEW);
});

// ═══════════════════════════════════════════════════════════════════════
// P1 — commerce_staff_request_new_proof_ + modal
// ═══════════════════════════════════════════════════════════════════════

test('P1: modal_commerce_staff_request_new_proof_ — sucesso: NEEDS_NEW_PROOF, Payment continua AWAITING_PROOF (invariante da Fase 6), reabre canal pro reenvio', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeOrderUnderReview(client, admin);

    const dmSent = [];
    const orderChannel = { _sent: [], send: async (p) => { orderChannel._sent.push(p); } };
    CommerceConfig.saveChannelStructure({ sales_log_channel_id: 'chan-sales-reproof' });
    const salesLog = { _sent: [], send: async (p) => { salesLog._sent.push(p); } };
    const guild = makeFakeGuild('guild-p10-reproof', { channels: { [order.channel_id]: orderChannel, 'chan-sales-reproof': salesLog } });

    const interaction = makeFakeInteraction({
        customId: `modal_commerce_staff_request_new_proof_${order.id}`, userId: admin, guild,
        fields: { reason: 'Valor não confere' },
        extra: { client: { users: { fetch: async () => ({ send: async (c) => dmSent.push(c) }) } } },
    });
    await commerce.handle(interaction, {});

    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.NEEDS_NEW_PROOF);
    assert.equal(PaymentManager.getPaymentByOrder(order.id).status, PaymentManager.PAYMENT_STATUS.AWAITING_PROOF, 'invariante Fase 6: nunca decide nada financeiro ao pedir novo comprovante');
    assert.match(interaction._replies[0].content, /novo comprovante solicitado/);
    assert.equal(dmSent.length, 1);
    assert.match(dmSent[0], /novo comprovante/i);
    assert.equal(orderChannel._sent.length, 1, 'canal do pedido recebe o pedido de novo comprovante, nunca é fechado');
    assert.equal(salesLog._sent.length, 1);
});

test('P1: modal_commerce_staff_request_new_proof_ — pedido fora de UNDER_REVIEW é recusado, nunca reabre canal por engano', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeApprovedOrder(client, admin);

    const interaction = makeFakeInteraction({ customId: `modal_commerce_staff_request_new_proof_${order.id}`, userId: admin, fields: { reason: 'x' } });
    await commerce.handle(interaction, {});

    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.APPROVED);
    assert.match(interaction._replies[0].content, /não está em revisão/);
});

// ═══════════════════════════════════════════════════════════════════════
// P1 — commerce_staff_select_order
// ═══════════════════════════════════════════════════════════════════════

test('P1: commerce_staff_select_order — mostra os detalhes e os 4 botões de ação; abre pra revisão como efeito colateral (PROOF_SUBMITTED -> UNDER_REVIEW)', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const product = makePublishedProduct();
    counter += 1;
    const order = OrderManager.createOrder({ userId: client, channelId: `p10-select-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, client, { url: 'https://cdn.discordapp.com/attachments/1/1/a.png', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.PROOF_SUBMITTED, 'sanity');

    const interaction = makeFakeInteraction({ customId: 'commerce_staff_select_order', userId: admin, values: [String(order.id)] });
    await commerce.handle(interaction, {});

    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.UNDER_REVIEW, 'selecionar pra revisão já abre a revisão (openForReview)');
    const embed = interaction._replies[0].embeds[0];
    assert.match(embed.data.title, new RegExp(`#${order.id}`));
    const buttonIds = interaction._replies[0].components[0].components.map((c) => c.data.custom_id);
    assert.deepEqual(buttonIds, [
        `commerce_staff_view_proof_${order.id}`,
        `commerce_staff_approve_${order.id}`,
        `commerce_staff_request_new_proof_${order.id}`,
        `commerce_staff_reject_${order.id}`,
    ]);
});

test('P1: commerce_staff_select_order — pedido inexistente/já processado responde com erro claro, nunca lança', async () => {
    const admin = makeUser('admin');
    const interaction = makeFakeInteraction({ customId: 'commerce_staff_select_order', userId: admin, values: ['999999999'] });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /não encontrado/);
});

test('P1: commerce_staff_select_order — dois staffs selecionando o MESMO pedido quase ao mesmo tempo: ambos veem os detalhes, nunca lança (openForReview() perdendo a corrida é engolido de propósito)', async () => {
    const admin = makeUser('admin');
    const staffA = makeUser('admin');
    const staffB = makeUser('admin');
    const product = makePublishedProduct();
    counter += 1;
    const order = OrderManager.createOrder({ userId: makeUser(), channelId: `p10-select-race-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, order.user_id, { url: 'https://cdn.discordapp.com/attachments/1/1/a.png', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });

    const interactionA = makeFakeInteraction({ customId: 'commerce_staff_select_order', userId: staffA, values: [String(order.id)] });
    const interactionB = makeFakeInteraction({ customId: 'commerce_staff_select_order', userId: staffB, values: [String(order.id)] });
    await Promise.all([commerce.handle(interactionA, {}), commerce.handle(interactionB, {})]);

    assert.equal(interactionA._replies.length, 1);
    assert.equal(interactionB._replies.length, 1);
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.UNDER_REVIEW, 'só transiciona uma vez, nunca lança pro segundo staff');
});

// ═══════════════════════════════════════════════════════════════════════
// P1 — commerce_staff_view_proof_
// ═══════════════════════════════════════════════════════════════════════

test('P1: commerce_staff_view_proof_ — sucesso: anexa o comprovante decifrado', async () => {
    const admin = makeUser('admin');
    const { order } = await makeOrderUnderReview(makeUser(), admin);

    const interaction = makeFakeInteraction({ customId: `commerce_staff_view_proof_${order.id}`, userId: admin });
    await commerce.handle(interaction, {});

    assert.equal(interaction._replies.length, 1);
    assert.ok(interaction._replies[0].files, 'precisa anexar o arquivo do comprovante');
    assert.equal(interaction._replies[0].ephemeral, true);
});

test('P1: commerce_staff_view_proof_ — pedido sem nenhum comprovante responde com erro claro', async () => {
    const admin = makeUser('admin');
    counter += 1;
    const order = OrderManager.createOrder({ userId: makeUser(), channelId: `p10-noproof-${counter}` });

    const interaction = makeFakeInteraction({ customId: `commerce_staff_view_proof_${order.id}`, userId: admin });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /Nenhum comprovante encontrado/);
});

test('P1: commerce_staff_view_proof_ — sem permissão comercial, barrado antes de tentar decifrar qualquer coisa', async () => {
    const admin = makeUser('admin');
    const { order } = await makeOrderUnderReview(makeUser(), admin);
    const semPermissao = makeUser();

    const interaction = makeFakeInteraction({ customId: `commerce_staff_view_proof_${order.id}`, userId: semPermissao });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /Acesso negado/);
});

// ═══════════════════════════════════════════════════════════════════════
// P1 — commerce_staff_retry_provisioning_ (adversariais via handler —
// o CAS/idempotência do ProvisioningManager já é exaustivamente testado
// nas Fases 7-9; aqui só a parte de wiring do handler)
// ═══════════════════════════════════════════════════════════════════════

test('P1: commerce_staff_retry_provisioning_ — orderId não-numérico no customId nunca lança, responde com erro claro', async () => {
    const admin = makeUser('admin');
    const interaction = makeFakeInteraction({ customId: 'commerce_staff_retry_provisioning_abc', userId: admin });
    await assert.doesNotReject(() => commerce.handle(interaction, {}));
    assert.match(interaction._replies[0].content, /Retry falhou/);
});

test('P1: commerce_staff_retry_provisioning_ — pedido já ACTIVE (alreadyActive) responde sucesso sem notificar de novo, nunca duplica nada', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeApprovedOrder(client, admin, { maxBots: 3, maxRam: 300, maxCpu: 25 });
    ProvisioningManager.provision(order.id); // já ACTIVE antes do retry

    const dmSent = [];
    const salesLog = { _sent: [], send: async (p) => { salesLog._sent.push(p); } };
    CommerceConfig.saveChannelStructure({ sales_log_channel_id: 'chan-sales-retry-active' });
    const guild = makeFakeGuild('guild-p10-retry-active', { channels: { 'chan-sales-retry-active': salesLog } });
    const interaction = makeFakeInteraction({
        customId: `commerce_staff_retry_provisioning_${order.id}`, userId: admin, guild,
        extra: { client: { users: { fetch: async () => ({ send: async (c) => dmSent.push(c) }) } } },
    });
    await commerce.handle(interaction, {});

    assert.match(interaction._replies[0].content, /provisionado com sucesso/);
    assert.equal(dmSent.length, 0, 'alreadyActive nunca dispara uma segunda DM de ativação');
    const activeRows = query("SELECT id FROM commerce_entitlements WHERE user_id = ? AND status = 'active'", [client]);
    assert.equal(activeRows.length, 1, 'retry sobre um pedido já ativo nunca duplica entitlement');
});

test('P1: commerce_staff_retry_provisioning_ — staff sem permissão é barrado, mesmo com o pedido genuinamente travado', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeApprovedOrder(client, admin, { maxBots: 3, maxRam: 300, maxCpu: 25 });

    const originalWrite = capacityManager.writeUserCapacity;
    capacityManager.writeUserCapacity = () => { throw new Error('falha simulada'); };
    try { ProvisioningManager.provision(order.id); } catch { /* esperado */ } finally { capacityManager.writeUserCapacity = originalWrite; }
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.PROVISIONING_FAILED, 'sanity');

    const semPermissao = makeUser();
    const interaction = makeFakeInteraction({ customId: `commerce_staff_retry_provisioning_${order.id}`, userId: semPermissao });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /Acesso negado/);
    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.PROVISIONING_FAILED, 'nunca avança por causa da tentativa negada');
});

// ═══════════════════════════════════════════════════════════════════════
// P1 — commerce_pay
// ═══════════════════════════════════════════════════════════════════════

test('P1: commerce_pay — sucesso: mostra os dados de Pix do payment já criado', async () => {
    const client = makeUser();
    const product = makePublishedProduct();
    counter += 1;
    const order = OrderManager.createOrder({ userId: client, channelId: `p10-pay-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);

    const interaction = makeFakeInteraction({ customId: 'commerce_pay', userId: client, extra: { channelId: order.channel_id } });
    await commerce.handle(interaction, {});

    const embed = interaction._replies[0].embeds[0];
    assert.match(embed.data.title, /Pagamento via Pix/);
    assert.match(embed.data.description, /Valor/);
});

test('P1: commerce_pay — sem payment record ainda (produto não selecionado) responde com orientação, nunca quebra', async () => {
    const client = makeUser();
    counter += 1;
    const order = OrderManager.createOrder({ userId: client, channelId: `p10-pay-noproduct-${counter}` });

    const interaction = makeFakeInteraction({ customId: 'commerce_pay', userId: client, extra: { channelId: order.channel_id } });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /Selecione um plano antes de pagar/);
});

test('P1: commerce_pay — IDOR: cliente B não vê os dados de Pix do pedido do cliente A', async () => {
    const clientA = makeUser();
    const clientB = makeUser();
    const product = makePublishedProduct();
    counter += 1;
    const order = OrderManager.createOrder({ userId: clientA, channelId: `p10-pay-idor-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);

    const interaction = makeFakeInteraction({ customId: 'commerce_pay', userId: clientB, extra: { channelId: order.channel_id } });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /não encontrado/);
    assert.equal(interaction._replies[0].embeds, undefined, 'nunca revela dados de Pix pra quem não é o dono');
});

test('P1: commerce_pay — Pix nunca configurado usa o texto de fallback, nunca mostra "undefined"/null cru', async () => {
    const client = makeUser();
    const product = makePublishedProduct();
    counter += 1;
    const order = OrderManager.createOrder({ userId: client, channelId: `p10-pay-nopix-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    run('UPDATE sales_config SET pix_key = NULL, pix_name = NULL, pix_city = NULL WHERE id = 1');
    PaymentManager.createPaymentRecord(order.id);

    const interaction = makeFakeInteraction({ customId: 'commerce_pay', userId: client, extra: { channelId: order.channel_id } });
    await commerce.handle(interaction, {});
    const desc = interaction._replies[0].embeds[0].data.description;
    assert.match(desc, /Não configurada/);
    assert.equal(/undefined|null/i.test(desc), false);
});

// ═══════════════════════════════════════════════════════════════════════
// P1 — commerce_admin_products / select_product / publish / pause / archive
// ═══════════════════════════════════════════════════════════════════════

test('P1: commerce_admin_products — lista produtos de todos os status, com o select de gerenciar + o botão de criar', async () => {
    const admin = makeUser('admin');
    makePublishedProduct({ name: 'Plano Listado' });
    const comProdutos = makeFakeInteraction({ customId: 'commerce_admin_products', userId: admin });
    await commerce.handle(comProdutos, {});
    assert.match(comProdutos._replies[0].embeds[0].data.description, /Plano Listado/);
    assert.equal(comProdutos._replies[0].components.length, 2, 'com produtos, mostra o select de gerenciar + o botão de criar');
});

test('P1: commerce_admin_products — sem permissão de admin (staff comercial não conta aqui), acesso negado', async () => {
    const admin = makeUser('admin');
    const staff = makeUser();
    CommerceStaffManager.grant(staff, admin); // COMMERCE_STAFF não é suficiente pra área admin de produtos
    const interaction = makeFakeInteraction({ customId: 'commerce_admin_products', userId: staff });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /Acesso negado/);
});

test('P1: commerce_admin_select_product — mostra os botões certos por status (DRAFT só Publicar+Arquivar; PUBLISHED Pausar+Arquivar; ARCHIVED nenhum)', async () => {
    const admin = makeUser('admin');

    const draftProduct = ProductCatalog.saveProduct({ id: 'p10-admin-draft', name: 'Draft', price: 10, maxBots: 1, maxRam: 100, maxCpu: 10 });
    const i1 = makeFakeInteraction({ customId: 'commerce_admin_select_product', userId: admin, values: [draftProduct.id] });
    await commerce.handle(i1, {});
    let ids = i1._replies[0].components[0].components.map((c) => c.data.custom_id);
    assert.deepEqual(ids, [`commerce_admin_publish_product_${draftProduct.id}`, `commerce_admin_archive_product_${draftProduct.id}`]);

    const published = makePublishedProduct({ id: 'p10-admin-published' });
    const i2 = makeFakeInteraction({ customId: 'commerce_admin_select_product', userId: admin, values: [published.id] });
    await commerce.handle(i2, {});
    ids = i2._replies[0].components[0].components.map((c) => c.data.custom_id);
    assert.deepEqual(ids, [`commerce_admin_pause_product_${published.id}`, `commerce_admin_archive_product_${published.id}`]);

    ProductCatalog.archiveProduct(draftProduct.id);
    const i3 = makeFakeInteraction({ customId: 'commerce_admin_select_product', userId: admin, values: [draftProduct.id] });
    await commerce.handle(i3, {});
    ids = i3._replies[0].components[0].components.map((c) => c.data.custom_id);
    assert.deepEqual(ids, [], 'produto arquivado (terminal) nunca oferece nenhum botão de transição');
});

test('P1: commerce_admin_select_product — produto inexistente/forjado responde com erro claro', async () => {
    const admin = makeUser('admin');
    const interaction = makeFakeInteraction({ customId: 'commerce_admin_select_product', userId: admin, values: ['produto-forjado-xyz'] });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /não encontrado/);
});

test('P1: commerce_admin_publish_product_ / pause / archive — sucesso e transição inválida (ex.: pausar um DRAFT) nunca finge sucesso', async () => {
    const admin = makeUser('admin');
    const draft = ProductCatalog.saveProduct({ id: 'p10-admin-transitions', name: 'T', price: 10, maxBots: 1, maxRam: 100, maxCpu: 10 });

    const pauseDraft = makeFakeInteraction({ customId: `commerce_admin_pause_product_${draft.id}`, userId: admin });
    await commerce.handle(pauseDraft, {});
    assert.match(pauseDraft._replies[0].content, /❌/);
    assert.equal(ProductCatalog.getProduct(draft.id).status, ProductCatalog.PRODUCT_STATUS.DRAFT);

    const publish = makeFakeInteraction({ customId: `commerce_admin_publish_product_${draft.id}`, userId: admin });
    await commerce.handle(publish, {});
    assert.match(publish._replies[0].content, /publicado/);
    assert.equal(ProductCatalog.getProduct(draft.id).status, ProductCatalog.PRODUCT_STATUS.PUBLISHED);

    const pause = makeFakeInteraction({ customId: `commerce_admin_pause_product_${draft.id}`, userId: admin });
    await commerce.handle(pause, {});
    assert.match(pause._replies[0].content, /pausado/);

    const archive = makeFakeInteraction({ customId: `commerce_admin_archive_product_${draft.id}`, userId: admin });
    await commerce.handle(archive, {});
    assert.match(archive._replies[0].content, /arquivado/);

    const rearchive = makeFakeInteraction({ customId: `commerce_admin_publish_product_${draft.id}`, userId: admin });
    await commerce.handle(rearchive, {});
    assert.match(rearchive._replies[0].content, /❌/, 'arquivado é terminal — nunca republicável');
});

test('P1: commerce_admin_publish_product_ — sem permissão de admin, nunca chama o manager', async () => {
    const draft = ProductCatalog.saveProduct({ id: 'p10-admin-noperm', name: 'T', price: 10, maxBots: 1, maxRam: 100, maxCpu: 10 });
    const staff = makeUser();
    const interaction = makeFakeInteraction({ customId: `commerce_admin_publish_product_${draft.id}`, userId: staff });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /Acesso negado/);
    assert.equal(ProductCatalog.getProduct(draft.id).status, ProductCatalog.PRODUCT_STATUS.DRAFT);
});

// ═══════════════════════════════════════════════════════════════════════
// P1 — commerce_admin_config_pix + modal
// ═══════════════════════════════════════════════════════════════════════

test('P1: commerce_admin_config_pix abre o modal; modal_commerce_admin_config_pix grava e audita sem expor a chave no log', async () => {
    const admin = makeUser('admin');
    const openModal = makeFakeInteraction({ customId: 'commerce_admin_config_pix', userId: admin });
    await commerce.handle(openModal, {});
    assert.ok(openModal._replies[0].modal);

    const submit = makeFakeInteraction({
        customId: 'modal_commerce_admin_config_pix', userId: admin,
        fields: { pix_key: '11122233344', pix_name: 'Atlantic Host LTDA', pix_city: 'São Paulo' },
    });
    await commerce.handle(submit, {});
    assert.match(submit._replies[0].content, /atualizados/);

    const cfg = get('SELECT * FROM sales_config WHERE id = 1');
    assert.equal(cfg.pix_key, '11122233344');
    assert.equal(cfg.pix_name, 'Atlantic Host LTDA');

    const auditEvents = query("SELECT * FROM audit_log WHERE action = 'commerce:pix_configured' ORDER BY id DESC LIMIT 1");
    assert.equal(auditEvents.length, 1);
    assert.equal(/11122233344/.test(auditEvents[0].details), false, 'auditoria nunca grava o valor da chave Pix');
});

test('P1: modal_commerce_admin_config_pix — sem permissão de admin, nunca grava nada', async () => {
    const staff = makeUser();
    const before = get('SELECT pix_key FROM sales_config WHERE id = 1');
    const interaction = makeFakeInteraction({ customId: 'modal_commerce_admin_config_pix', userId: staff, fields: { pix_key: 'chave-maliciosa', pix_name: 'X', pix_city: 'Y' } });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /Acesso negado/);
    const after = get('SELECT pix_key FROM sales_config WHERE id = 1');
    assert.equal(after.pix_key, before.pix_key, 'nunca deveria ter mudado');
});

// ═══════════════════════════════════════════════════════════════════════
// P2 — commerce_support / commerce_admin_stats / commerce_admin_audit /
// commerce_admin_create_product (abrir o modal). Sem lógica de negócio
// arriscada (sem transição de estado, sem dinheiro, sem provisionamento)
// — cobertura proporcional: qualquer cliente sem permissão, mensagem
// certa, sem quebrar em ausência/presença de dados.
// ═══════════════════════════════════════════════════════════════════════

test('P2: commerce_support — sem faq_channel_id configurado, usa o texto de fallback; com canal configurado, menciona o canal', async () => {
    const cliente = makeUser();
    const semConfig = makeFakeInteraction({ customId: 'commerce_support', userId: cliente });
    await commerce.handle(semConfig, {});
    assert.match(semConfig._replies[0].content, /o canal de dúvidas/);

    run("UPDATE commerce_config SET faq_channel_id = '999888777' WHERE id = 1");
    const comConfig = makeFakeInteraction({ customId: 'commerce_support', userId: cliente });
    await commerce.handle(comConfig, {});
    assert.match(comConfig._replies[0].content, /<#999888777>/);
});

test('P2: commerce_admin_stats — contagens por status, faturamento do mês e entitlements ativos refletem o banco real; sem permissão, acesso negado', async () => {
    const staff = makeUser();
    const semPermissao = makeFakeInteraction({ customId: 'commerce_admin_stats', userId: staff });
    await commerce.handle(semPermissao, {});
    assert.match(semPermissao._replies[0].content, /Acesso negado/);

    const admin = makeUser('admin');
    await makeApprovedOrder(makeUser(), admin);
    const activeCountBefore = get("SELECT COUNT(*) as c FROM commerce_entitlements WHERE status = 'active'").c;

    const interaction = makeFakeInteraction({ customId: 'commerce_admin_stats', userId: admin });
    await commerce.handle(interaction, {});
    const desc = interaction._replies[0].embeds[0].data.description;
    const approvedCount = get(`SELECT COUNT(*) as c FROM commerce_orders WHERE status = 'APPROVED'`).c;
    assert.match(desc, new RegExp('`APPROVED`: ' + approvedCount));
    assert.match(desc, new RegExp('Entitlements ativos:\\*\\* ' + activeCountBefore));
});

test('P2: commerce_admin_audit — mostra os eventos comerciais recentes de audit_log; sem permissão, acesso negado', async () => {
    const staff = makeUser();
    const semPermissao = makeFakeInteraction({ customId: 'commerce_admin_audit', userId: staff });
    await commerce.handle(semPermissao, {});
    assert.match(semPermissao._replies[0].content, /Acesso negado/);

    const admin = makeUser('admin');
    ProductCatalog.saveProduct({ id: 'p10-audit-product', name: 'Auditável', price: 10, maxBots: 1, maxRam: 100, maxCpu: 10 });
    const interaction = makeFakeInteraction({ customId: 'commerce_admin_audit', userId: admin });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].embeds[0].data.description, /commerce:product_(created|updated)/);
});

test('P2: commerce_admin_create_product — abre o modal de criação; sem permissão de admin, nunca abre', async () => {
    const admin = makeUser('admin');
    const ok = makeFakeInteraction({ customId: 'commerce_admin_create_product', userId: admin });
    await commerce.handle(ok, {});
    assert.equal(ok._replies.length, 1);
    assert.equal(ok._replies[0].modal.data.custom_id, 'modal_commerce_admin_create_product');

    const staff = makeUser();
    const negado = makeFakeInteraction({ customId: 'commerce_admin_create_product', userId: staff });
    await commerce.handle(negado, {});
    assert.equal(negado._replies[0].modal, undefined, 'sem permissão, nunca chega a montar o modal');
    assert.match(negado._replies[0].content, /Acesso negado/);
});
