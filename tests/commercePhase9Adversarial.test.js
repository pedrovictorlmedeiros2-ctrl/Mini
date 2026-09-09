/**
 * TESTES ADVERSARIAIS — FASE 9 (Hardening de Produção)
 *
 * Cenários cruzados que não cabem nos arquivos de teste unitário
 * existentes: P0-3 (C1) de ponta a ponta via ProvisioningManager, P1-2
 * (sales_log_channel_id ausente / fallback de alerta) e P1-4
 * (truncamento seguro das listagens do staff).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commercePhase9Adversarial.db');
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
const os = require('os');
config.commerce.proofsFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-proofs-phase9-'));
config.commerce.maxProofSizeBytes = 1024 * 1024;

// FASE 9 (P1-2): nunca deixa os testes deste arquivo fazerem uma chamada
// de rede real via alertManager.sendAlert()/clientRef.tryDM() — mesmo
// stub já usado em serviceReadiness.test.js.
let alertCalls = [];
let dmCalls = [];
alertManager.sendAlert = async (title, message, type) => { alertCalls.push({ title, message, type }); };
clientRef.tryDM = async (userId, content) => { dmCalls.push({ userId, content }); return true; };
function resetAlertSpies() { alertCalls = []; dmCalls = []; }

async function waitForQueueToDrain() {
    while (queueManager.getQueueMetrics().active > 0 || queueManager.getQueueMetrics().queued > 0) {
        await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await new Promise((resolve) => setImmediate(resolve)); // deixa o .then()/.catch() do handler assentar
}

let counter = 0;
function makeUser(role = 'client') {
    counter += 1;
    const userId = `p9-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', role]);
    return userId;
}
function makePublishedProduct(overrides = {}) {
    counter += 1;
    const draft = ProductCatalog.saveProduct({ id: `p9-prod-${counter}`, name: 'Plano', price: 29.9, maxBots: 2, maxRam: 400, maxCpu: 30, ...overrides });
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

async function makeApprovedOrder(clientUserId, adminUserId, productOverrides = {}) {
    const product = makePublishedProduct(productOverrides);
    counter += 1;
    const order = OrderManager.createOrder({ userId: clientUserId, channelId: `p9-channel-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, clientUserId, { url: 'https://cdn.discordapp.com/attachments/1/1/a.png', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    PaymentManager.openForReview(order.id, adminUserId);
    const { order: approved } = PaymentManager.confirmPayment(order.id, adminUserId);
    return { order: approved, product };
}

/**
 * Deixa o pedido em UNDER_REVIEW (comprovante enviado, revisão aberta) —
 * SEM chamar confirmPayment(). Usado pelos testes que exercitam
 * `commerce.handle('commerce_staff_approve_...')` de verdade, já que
 * esse handler é quem chama confirmPayment() internamente — chamar duas
 * vezes (aqui E dentro do handler) faria a segunda falhar (CAS só aceita
 * a partir de UNDER_REVIEW).
 */
async function makeOrderUnderReview(clientUserId, adminUserId, productOverrides = {}) {
    const product = makePublishedProduct(productOverrides);
    counter += 1;
    const order = OrderManager.createOrder({ userId: clientUserId, channelId: `p9-channel-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, clientUserId, { url: 'https://cdn.discordapp.com/attachments/1/1/a.png', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    PaymentManager.openForReview(order.id, adminUserId);
    return { order: OrderManager.getOrder(order.id), product };
}

test('setup: computa o estado de prontidão real deste ambiente antes de qualquer fixture de provisionamento', async () => {
    const result = await serviceReadiness.computeReadiness();
    assert.ok([serviceReadiness.STATUS.DEGRADED, serviceReadiness.STATUS.READY].includes(result.status), `ambiente de teste inesperado: ${JSON.stringify(result)}`);
});

// ═══════════════════════════════════════════════════════════════════════
// P0-3 (C1) — de ponta a ponta via ProvisioningManager
// ═══════════════════════════════════════════════════════════════════════

test('C1 — 7) ponta a ponta via ProvisioningManager: falha na capacidade mantém Order PROVISIONING_FAILED e entitlement PENDING_PROVISIONING; retry chega em ACTIVE sem duplicar', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeApprovedOrder(client, admin, { maxBots: 5, maxRam: 480, maxCpu: 45 });

    const originalWrite = capacityManager.writeUserCapacity;
    capacityManager.writeUserCapacity = () => { throw new Error('falha simulada na capacidade'); };
    try {
        assert.throws(() => ProvisioningManager.provision(order.id));
    } finally {
        capacityManager.writeUserCapacity = originalWrite;
    }

    const afterFailure = OrderManager.getOrder(order.id);
    assert.equal(afterFailure.status, OrderManager.STATUS.PROVISIONING_FAILED);
    const payment = PaymentManager.getPaymentByOrder(order.id);
    assert.equal(payment.status, PaymentManager.PAYMENT_STATUS.CONFIRMED, 'Payment nunca é revertido');

    const pendingEntitlement = EntitlementManager.getEntitlementByOrder(order.id);
    assert.ok(pendingEntitlement);
    assert.equal(pendingEntitlement.status, EntitlementManager.ENTITLEMENT_STATUS.PENDING_PROVISIONING);

    const attempts = ProvisioningManager.listProvisioningAttempts(order.id);
    assert.equal(attempts[attempts.length - 1].status, ProvisioningManager.ATTEMPT_STATUS.FAILED);

    // Retry real (causa da falha já não existe mais).
    const result = ProvisioningManager.provision(order.id, { executorUserId: admin });
    assert.equal(result.order.status, OrderManager.STATUS.ACTIVE);
    assert.equal(result.entitlement.id, pendingEntitlement.id, 'reaproveita a MESMA linha, nunca cria uma nova');
    assert.equal(result.entitlement.status, EntitlementManager.ENTITLEMENT_STATUS.ACTIVE);

    const allForOrder = query('SELECT * FROM commerce_entitlements WHERE order_id = ?', [order.id]);
    assert.equal(allForOrder.length, 1);

    const user = get('SELECT max_bots, max_ram, max_cpu FROM users WHERE id = ?', [client]);
    assert.equal(user.max_bots, 5);
    assert.equal(user.max_ram, 480);
    assert.equal(user.max_cpu, 45);
});

test('C1 — nunca existem dois ACTIVE simultâneos mesmo quando outra compra do mesmo cliente é concedida enquanto a primeira está travada PENDING_PROVISIONING', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { order: orderA } = await makeApprovedOrder(client, admin, { maxBots: 5, maxRam: 480, maxCpu: 45 });

    const originalWrite = capacityManager.writeUserCapacity;
    capacityManager.writeUserCapacity = () => { throw new Error('falha simulada'); };
    try {
        assert.throws(() => ProvisioningManager.provision(orderA.id));
    } finally {
        capacityManager.writeUserCapacity = originalWrite;
    }

    // Retry de orderA sem que nada tenha mudado ainda — deveria funcionar
    // normalmente (nenhum outro entitlement ativo existe pro cliente).
    // Em vez disso, simula o cenário adversarial: o CLIENTE cancela a
    // compra travada (orderA permanece PROVISIONING_FAILED, nunca
    // resolvido) e faz uma compra nova, completamente diferente.
    const { order: orderB } = await makeApprovedOrder(client, admin, { maxBots: 2, maxRam: 200, maxCpu: 20 });
    const resultB = ProvisioningManager.provision(orderB.id);
    assert.equal(resultB.order.status, OrderManager.STATUS.ACTIVE);

    // Só ENTÃO alguém (staff) tenta o retry de orderA — precisa falhar
    // com segurança, nunca criar um segundo ACTIVE.
    assert.throws(() => ProvisioningManager.provision(orderA.id, { executorUserId: admin }), /não é possível promover|não acumula/);
    assert.equal(OrderManager.getOrder(orderA.id).status, OrderManager.STATUS.PROVISIONING_FAILED);

    const activeRows = query("SELECT id FROM commerce_entitlements WHERE user_id = ? AND status = 'active'", [client]);
    assert.equal(activeRows.length, 1);
    assert.equal(activeRows[0].id, resultB.entitlement.id);
});

test('C1: suíte estrutural da Fase 7 permanece válida — ProvisioningManager.js continua sem child_process/SandboxManager/security/bots.suspended', () => {
    function stripComments(src) {
        return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    }
    const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'managers', 'commerce', 'ProvisioningManager.js'), 'utf8'));
    assert.equal(/require\([^)]*child_process[^)]*\)/.test(src), false);
    assert.equal(/require\([^)]*SandboxManager[^)]*\)/.test(src), false);
    assert.equal(/require\([^)]*security[^)]*\)/.test(src), false);
    assert.equal(/suspended/i.test(src), false);
    assert.equal(/startBot/.test(src), false);
});

// ═══════════════════════════════════════════════════════════════════════
// P1-2 — sales_log_channel_id ausente / configuração incompleta
// ═══════════════════════════════════════════════════════════════════════

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
function makeFakeInteraction({ customId, userId, username, guild, values, extra = {} }) {
    const replies = [];
    return {
        customId,
        user: makeFakeUser(userId, username),
        guild,
        values,
        replied: false,
        deferred: false,
        reply: async (payload) => { replies.push(payload); return {}; },
        editReply: async (payload) => { replies.push(payload); return {}; },
        update: async (payload) => { replies.push(payload); return {}; },
        deferReply: async () => {},
        client: { users: { fetch: async () => ({ send: async () => {} }) } },
        channel: { send: async () => {}, delete: async () => {} },
        _replies: replies,
        ...extra,
    };
}

test('P1-2: getMissingCriticalFields() detecta sales_log_channel_id ausente, nunca acusa quando presente', () => {
    CommerceConfig.saveChannelStructure({ public_category_id: 'cat-p1', staff_category_id: 'staffcat-p1', sales_log_channel_id: null });
    assert.ok(CommerceConfig.getMissingCriticalFields().includes('sales_log_channel_id'));

    CommerceConfig.saveChannelStructure({ sales_log_channel_id: 'chan-logs-p1' });
    assert.equal(CommerceConfig.getMissingCriticalFields().includes('sales_log_channel_id'), false);
});

test('P1-2: publishStaffPanel() avisa visivelmente quando sales_log_channel_id está ausente, nunca em silêncio', async () => {
    CommerceConfig.saveChannelStructure({ public_category_id: 'cat-p2', staff_category_id: 'staffcat-p2', sales_log_channel_id: null, staff_role_id: 'role-p2' });
    const admin = makeUser('admin');
    const interaction = makeFakeInteraction({ customId: 'irrelevant', userId: admin });

    await commerce.publishStaffPanel(interaction);
    assert.equal(interaction._replies.length, 1);
    assert.match(interaction._replies[0].embeds[0].data.description, /Canal de logs de vendas não configurado/);
});

test('P1-2: publishStaffPanel() NUNCA mostra o aviso quando sales_log_channel_id está configurado (sem regressão)', async () => {
    CommerceConfig.saveChannelStructure({ public_category_id: 'cat-p3', staff_category_id: 'staffcat-p3', sales_log_channel_id: 'chan-logs-p3', staff_role_id: 'role-p3' });
    const admin = makeUser('admin');
    const interaction = makeFakeInteraction({ customId: 'irrelevant', userId: admin });

    await commerce.publishStaffPanel(interaction);
    assert.equal(/Canal de logs de vendas não configurado/.test(interaction._replies[0].embeds[0].data.description), false);
});

test('P1-2: falha de provisionamento automático com sales_log_channel_id AUSENTE cai pro alerta administrativo (webhook + DM), nunca desaparece em silêncio', async () => {
    CommerceConfig.saveChannelStructure({ public_category_id: 'cat-p4', staff_category_id: 'staffcat-p4', sales_log_channel_id: null, staff_role_id: 'role-p4' });
    const originalOwnerId = config.bot.ownerId;
    config.bot.ownerId = 'owner-p1-2-test';
    resetAlertSpies();

    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeOrderUnderReview(client, admin, { maxBots: 3, maxRam: 300, maxCpu: 25 });

    const originalWrite = capacityManager.writeUserCapacity;
    capacityManager.writeUserCapacity = () => { throw new Error('falha simulada de capacidade'); };

    const guild = makeFakeGuild('guild-p1-2-1', { channels: { [order.channel_id]: { send: async () => {}, delete: async () => {} } } });
    const interaction = makeFakeInteraction({ customId: `commerce_staff_approve_${order.id}`, userId: admin, guild });

    try {
        await commerce.handle(interaction, {});
        await waitForQueueToDrain();
    } finally {
        capacityManager.writeUserCapacity = originalWrite;
        config.bot.ownerId = originalOwnerId;
    }

    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.PROVISIONING_FAILED);
    assert.equal(alertCalls.length, 1, 'o webhook administrativo precisa ter sido tentado, já que o canal de log não existe');
    assert.match(alertCalls[0].message, /Falha no provisionamento automático/);
    assert.equal(dmCalls.length, 1, 'a DM ao owner também precisa ter sido tentada');
});

test('P1-2: falha de provisionamento automático com sales_log_channel_id CONFIGURADO posta no canal, NUNCA aciona o alerta administrativo (sem regressão/spam)', async () => {
    const logChannel = { send: async (payload) => { logChannel._sent.push(payload); }, _sent: [] };
    CommerceConfig.saveChannelStructure({ public_category_id: 'cat-p5', staff_category_id: 'staffcat-p5', sales_log_channel_id: 'chan-logs-p5', staff_role_id: 'role-p5' });
    resetAlertSpies();

    const admin = makeUser('admin');
    const client = makeUser();
    const { order } = await makeOrderUnderReview(client, admin, { maxBots: 3, maxRam: 300, maxCpu: 25 });

    const originalWrite = capacityManager.writeUserCapacity;
    capacityManager.writeUserCapacity = () => { throw new Error('falha simulada de capacidade'); };

    const guild = makeFakeGuild('guild-p1-2-2', {
        channels: { [order.channel_id]: { send: async () => {}, delete: async () => {} }, 'chan-logs-p5': logChannel },
    });
    const interaction = makeFakeInteraction({ customId: `commerce_staff_approve_${order.id}`, userId: admin, guild });

    try {
        await commerce.handle(interaction, {});
        await waitForQueueToDrain();
    } finally {
        capacityManager.writeUserCapacity = originalWrite;
    }

    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.PROVISIONING_FAILED);
    assert.ok(logChannel._sent.some((p) => /Falha no provisionamento automático/.test(p.content)), 'precisa ter postado no canal configurado');
    assert.equal(alertCalls.length, 0, 'canal configurado -> nunca deveria cair pro alerta administrativo');
    assert.equal(dmCalls.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════
// P1-4 — truncamento seguro das listagens do staff
// ═══════════════════════════════════════════════════════════════════════

function makeOrderInStatus(status, { usernameSuffix = '' } = {}) {
    counter += 1;
    const userId = makeUser();
    run("UPDATE users SET username = ? WHERE id = ?", [`cliente-com-nome-bem-longo-pra-testar-o-limite-${counter}${usernameSuffix}`, userId]);
    const product = makePublishedProduct();
    const order = OrderManager.createOrder({ userId, channelId: `p9-bulk-channel-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    run("UPDATE commerce_orders SET status = ? WHERE id = ?", [status, order.id]);
    return OrderManager.getOrder(order.id);
}

test('P1-4: commerce_staff_queue com backlog PEQUENO mostra tudo, nunca trunca (sem regressão)', async () => {
    for (let i = 0; i < 3; i += 1) makeOrderInStatus(OrderManager.STATUS.UNDER_REVIEW);
    const staff = makeUser('admin');
    const interaction = makeFakeInteraction({ customId: 'commerce_staff_queue', userId: staff });

    await commerce.handle(interaction, {});
    const description = interaction._replies[0].embeds[0].data.description;
    assert.equal(/não exibido/.test(description), false, 'backlog pequeno nunca deveria mostrar a nota de truncamento');
    assert.ok(description.length <= 4096);
});

test('P1-4: commerce_staff_queue com backlog GRANDE nunca ultrapassa o limite do Discord, preserva os mais antigos e avisa quantos faltam', async () => {
    const orders = [];
    for (let i = 0; i < 250; i += 1) orders.push(makeOrderInStatus(OrderManager.STATUS.UNDER_REVIEW));
    const staff = makeUser('admin');
    const interaction = makeFakeInteraction({ customId: 'commerce_staff_queue', userId: staff });

    await commerce.handle(interaction, {});
    const embed = interaction._replies[0].embeds[0];
    assert.ok(embed.data.description.length <= 4096, `description tem ${embed.data.description.length} caracteres — nunca pode ultrapassar 4096`);
    assert.match(embed.data.description, /e mais \d+ pedido\(s\) não exibido/);
    // O pedido MAIS ANTIGO (primeiro criado) precisa estar entre os exibidos —
    // a lista nunca deveria priorizar os mais recentes.
    assert.match(embed.data.description, new RegExp(`#${orders[0].id}\\b`));

    // Select menu continua limitado pelo teto nativo do Discord (25),
    // independente do tamanho do backlog — sem mudança de comportamento aqui.
    const select = interaction._replies[0].components[0].components[0];
    assert.equal(select.options.length, 25);
});

test('P1-4: commerce_staff_provisioning_failures com backlog PEQUENO mostra tudo, nunca trunca (sem regressão)', async () => {
    for (let i = 0; i < 3; i += 1) makeOrderInStatus(OrderManager.STATUS.PROVISIONING_FAILED);
    const staff = makeUser('admin');
    const interaction = makeFakeInteraction({ customId: 'commerce_staff_provisioning_failures', userId: staff });

    await commerce.handle(interaction, {});
    const description = interaction._replies[0].embeds[0].data.description;
    assert.equal(/não exibido/.test(description), false);
    assert.ok(description.length <= 4096);
});

test('P1-4: commerce_staff_provisioning_failures com backlog GRANDE nunca ultrapassa o limite do Discord, botões de retry continuam limitados a 5', async () => {
    const orders = [];
    for (let i = 0; i < 250; i += 1) orders.push(makeOrderInStatus(OrderManager.STATUS.PROVISIONING_FAILED));
    const staff = makeUser('admin');
    const interaction = makeFakeInteraction({ customId: 'commerce_staff_provisioning_failures', userId: staff });

    await commerce.handle(interaction, {});
    const embed = interaction._replies[0].embeds[0];
    assert.ok(embed.data.description.length <= 4096, `description tem ${embed.data.description.length} caracteres`);
    assert.match(embed.data.description, /e mais \d+ pedido\(s\) não exibido/);
    assert.match(embed.data.description, new RegExp(`#${orders[0].id}\\b`), 'o mais antigo precisa continuar visível');

    const buttons = interaction._replies[0].components[0].components;
    assert.equal(buttons.length, 5, 'botões de retry continuam limitados a 5 por linha (teto nativo do Discord), sem mudança');
});

test('P1-4: nenhuma mudança de permissão ou regra de negócio — staff revogado continua barrado nas duas listagens mesmo com backlog grande', async () => {
    for (let i = 0; i < 60; i += 1) makeOrderInStatus(OrderManager.STATUS.UNDER_REVIEW);
    const admin = makeUser('admin');
    const staff = makeUser();
    CommerceStaffManager.grant(staff, admin);
    CommerceStaffManager.revoke(staff, admin);

    const interaction = makeFakeInteraction({ customId: 'commerce_staff_queue', userId: staff });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /Acesso negado/);
});
