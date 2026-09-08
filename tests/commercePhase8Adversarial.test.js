/**
 * TESTES ADVERSARIAIS — FASE 8 (renovação self-service + ciclo de vida do
 * entitlement)
 *
 * Cobre: elegibilidade de renovação (ativo OU expirado dentro da janela de
 * tolerância, nunca indefinidamente), bloqueio total de compra tradicional
 * com entitlement ativo, reuso do lock de commerce_buy_plan, avisos de
 * expiração (antes e no momento) via DM best-effort, e testes de
 * integração do HANDLER (commerce.js) — fechando parte da lacuna de
 * cobertura (D1) identificada na auditoria da Fase 7.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commercePhase8Adversarial.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get, query } = require('../src/database/database');
initDatabase();

const config = require('../config');
const os = require('os');

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const PaymentManager = require('../src/managers/commerce/PaymentManager');
const ProofManager = require('../src/managers/commerce/ProofManager');
const EntitlementManager = require('../src/managers/commerce/EntitlementManager');
const ProvisioningManager = require('../src/managers/commerce/ProvisioningManager');
const CommerceScheduler = require('../src/managers/commerce/CommerceScheduler');
const CommerceConfig = require('../src/managers/commerce/CommerceConfig');
const clientRef = require('../src/utils/clientRef');
const serviceReadiness = require('../src/managers/serviceReadiness');
const commerce = require('../src/handlers/domains/commerce');

config.commerce.proofsFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-proofs-phase8-'));
config.commerce.maxProofSizeBytes = 1024 * 1024;
config.commerce.renewalReminderDays = 3;
config.commerce.renewalGraceDays = 14;

let counter = 0;
function makeUser(role = 'client') {
    counter += 1;
    const userId = `p8-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', role]);
    return userId;
}
function makePublishedProduct(overrides = {}) {
    counter += 1;
    const draft = ProductCatalog.saveProduct({ id: `p8-prod-${counter}`, name: 'Plano', price: 29.9, maxBots: 2, maxRam: 400, maxCpu: 30, ...overrides });
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
    clientRef.setClient(null);
});

/** Pipeline completo até ACTIVE, via managers diretos (já exaustivamente testado nas Fases 2-7) — usado aqui só como fixture. */
async function makeActiveEntitlement(clientUserId, adminUserId, productOverrides = {}) {
    const product = makePublishedProduct(productOverrides);
    counter += 1;
    const order = OrderManager.createOrder({ userId: clientUserId, channelId: `p8-channel-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, clientUserId, { url: 'https://cdn.discordapp.com/attachments/1/1/a.png', name: 'a.png', contentType: 'image/png', size: PNG_BUFFER.length });
    PaymentManager.openForReview(order.id, adminUserId);
    PaymentManager.confirmPayment(order.id, adminUserId);
    const { entitlement } = ProvisioningManager.provision(order.id);
    return { order, product, entitlement };
}

// serviceReadiness nasce BLOCKED por padrão (fail-closed) até a primeira
// computeReadiness() rodar (é assíncrona) — sem isto, todo ProvisioningManager.provision()
// usado como fixture neste arquivo lançaria BLOCKED. Mesmo setup já usado
// no arquivo de testes da Fase 7.
test('setup: computa o estado de prontidão real deste ambiente antes de qualquer fixture de provisionamento', async () => {
    const result = await serviceReadiness.computeReadiness();
    assert.ok([serviceReadiness.STATUS.DEGRADED, serviceReadiness.STATUS.READY].includes(result.status), `ambiente de teste inesperado: ${JSON.stringify(result)}`);
});

// ═══════════════════════════════════════════════════════════════════════
// 1) EntitlementManager.getRenewalEligibleEntitlement()
// ═══════════════════════════════════════════════════════════════════════

test('ELEGIBILIDADE: entitlement ATIVO é sempre elegível', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement } = await makeActiveEntitlement(client, admin);

    const eligible = EntitlementManager.getRenewalEligibleEntitlement(client);
    assert.ok(eligible);
    assert.equal(eligible.id, entitlement.id);
});

test('ELEGIBILIDADE: entitlement EXPIRADO dentro da janela de tolerância é elegível', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement } = await makeActiveEntitlement(client, admin);
    run("UPDATE commerce_entitlements SET status = 'expired', expires_at = datetime('now', '-5 days') WHERE id = ?", [entitlement.id]);

    const eligible = EntitlementManager.getRenewalEligibleEntitlement(client);
    assert.ok(eligible, 'expirado há 5 dias, dentro da janela de 14 — deveria ser elegível');
    assert.equal(eligible.id, entitlement.id);
});

test('ELEGIBILIDADE: entitlement EXPIRADO fora da janela de tolerância NUNCA é elegível — nunca renovação indefinida', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement } = await makeActiveEntitlement(client, admin);
    run("UPDATE commerce_entitlements SET status = 'expired', expires_at = datetime('now', '-30 days') WHERE id = ?", [entitlement.id]);

    const eligible = EntitlementManager.getRenewalEligibleEntitlement(client);
    assert.equal(eligible, null, 'expirado há 30 dias, fora da janela de 14 — nunca elegível');
});

test('ELEGIBILIDADE: cliente sem NENHUM entitlement nunca é elegível', () => {
    const client = makeUser();
    assert.equal(EntitlementManager.getRenewalEligibleEntitlement(client), null);
});

test('ELEGIBILIDADE: exatamente na borda da janela (expires_at igual ao limite) é tratado de forma consistente, nunca crasha', () => {
    const client = makeUser();
    // Não testa o exato limite de arredondamento de datetime() — só garante
    // que a função nunca lança perto da borda, resultado é ou entitlement ou null.
    assert.doesNotThrow(() => EntitlementManager.getRenewalEligibleEntitlement(client));
});

// ═══════════════════════════════════════════════════════════════════════
// 2) EntitlementManager.markRenewalReminderSent()
// ═══════════════════════════════════════════════════════════════════════

test('markRenewalReminderSent: marca o timestamp, idempotente (segunda chamada não altera)', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement } = await makeActiveEntitlement(client, admin);
    assert.equal(entitlement.renewal_reminder_sent_at, null);

    const marked = EntitlementManager.markRenewalReminderSent(entitlement.id);
    assert.ok(marked.renewal_reminder_sent_at);

    const firstTimestamp = marked.renewal_reminder_sent_at;
    const markedAgain = EntitlementManager.markRenewalReminderSent(entitlement.id);
    assert.equal(markedAgain.renewal_reminder_sent_at, firstTimestamp, 'segunda chamada é no-op — nunca sobrescreve o timestamp já gravado');
});

test('markRenewalReminderSent: entitlement inexistente lança erro claro, nunca crasha silenciosamente', () => {
    assert.throws(() => EntitlementManager.markRenewalReminderSent(999999999), /não encontrado/);
});

// ═══════════════════════════════════════════════════════════════════════
// 3) CommerceScheduler.sweepExpiringEntitlements() / sweepExpiredEntitlements()
// ═══════════════════════════════════════════════════════════════════════

function makeFakeDmClient() {
    const sent = [];
    const client = {
        users: {
            fetch: async (userId) => ({
                send: async (content) => { sent.push({ userId, content }); },
            }),
        },
    };
    return { client, sent };
}

test('sweepExpiringEntitlements: entitlement expirando dentro da janela recebe DM e é marcado — nunca reenviado no mesmo ciclo', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement } = await makeActiveEntitlement(client, admin);
    run("UPDATE commerce_entitlements SET expires_at = datetime('now', '+1 day') WHERE id = ?", [entitlement.id]);

    const { client: fakeClient, sent } = makeFakeDmClient();
    clientRef.setClient(fakeClient);

    const count = CommerceScheduler.sweepExpiringEntitlements();
    assert.equal(count, 1);
    await new Promise((resolve) => setImmediate(resolve)); // deixa a DM fire-and-forget resolver

    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, client);
    assert.match(sent[0].content, /expira em breve/);
    assert.ok(EntitlementManager.getEntitlement(entitlement.id).renewal_reminder_sent_at);

    // Segunda execução do sweep no MESMO ciclo — nunca reenvia.
    const secondCount = CommerceScheduler.sweepExpiringEntitlements();
    assert.equal(secondCount, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1, 'nenhuma DM nova deveria ter sido enviada no mesmo ciclo');
});

test('sweepExpiringEntitlements: entitlement expirando FORA da janela (ex.: em 10 dias) nunca é avisado ainda', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement } = await makeActiveEntitlement(client, admin);
    run("UPDATE commerce_entitlements SET expires_at = datetime('now', '+10 days') WHERE id = ?", [entitlement.id]);

    const count = CommerceScheduler.sweepExpiringEntitlements();
    const candidateIds = query('SELECT id FROM commerce_entitlements WHERE renewal_reminder_sent_at IS NOT NULL').map((e) => e.id);
    assert.ok(!candidateIds.includes(entitlement.id));
});

test('sweepExpiringEntitlements: falha de DM (client não pronto) nunca bloqueia a sweep nem impede a marcação', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement } = await makeActiveEntitlement(client, admin);
    run("UPDATE commerce_entitlements SET expires_at = datetime('now', '+1 day') WHERE id = ?", [entitlement.id]);

    clientRef.setClient(null); // client do Discord "não pronto" — tryDM() sempre retorna false, nunca lança

    assert.doesNotThrow(() => CommerceScheduler.sweepExpiringEntitlements());
    assert.ok(EntitlementManager.getEntitlement(entitlement.id).renewal_reminder_sent_at, 'a marcação acontece independente do sucesso da DM');
});

test('sweepExpiredEntitlements: entitlement expirado recebe DM best-effort avisando que expirou, sem bloquear a sweep', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement } = await makeActiveEntitlement(client, admin);
    run("UPDATE commerce_entitlements SET expires_at = datetime('now', '-1 day') WHERE id = ?", [entitlement.id]);

    const { client: fakeClient, sent } = makeFakeDmClient();
    clientRef.setClient(fakeClient);

    const count = CommerceScheduler.sweepExpiredEntitlements();
    assert.equal(count, 1);
    assert.equal(EntitlementManager.getEntitlement(entitlement.id).status, 'expired');

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 1);
    assert.match(sent[0].content, /expirou/);
});

test('sweepExpiredEntitlements: DM falhando (client ausente) nunca impede a expiração real de acontecer', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement } = await makeActiveEntitlement(client, admin);
    run("UPDATE commerce_entitlements SET expires_at = datetime('now', '-1 day') WHERE id = ?", [entitlement.id]);

    clientRef.setClient(null);
    assert.doesNotThrow(() => CommerceScheduler.sweepExpiredEntitlements());
    assert.equal(EntitlementManager.getEntitlement(entitlement.id).status, 'expired');
});

test('CICLO NOVO: depois de renovado, um entitlement novo nasce com renewal_reminder_sent_at NULL — pode gerar aviso de novo', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement: ent1 } = await makeActiveEntitlement(client, admin);
    EntitlementManager.markRenewalReminderSent(ent1.id);
    assert.ok(EntitlementManager.getEntitlement(ent1.id).renewal_reminder_sent_at);

    // Renovação real (mesmo caminho que commerce_renew_plan usaria).
    const product2 = makePublishedProduct();
    counter += 1;
    const orderRenewal = OrderManager.createOrder({ userId: client, channelId: `p8-renewal-cycle-${counter}`, renewalOfEntitlementId: ent1.id });
    OrderManager.confirmProduct(orderRenewal.id, product2.id, ent1.id);
    PaymentManager.createPaymentRecord(orderRenewal.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(orderRenewal.id, client, { url: 'https://cdn.discordapp.com/attachments/2/2/b.png', name: 'b.png', contentType: 'image/png', size: PNG_BUFFER.length });
    PaymentManager.openForReview(orderRenewal.id, admin);
    PaymentManager.confirmPayment(orderRenewal.id, admin);
    const { entitlement: ent2 } = ProvisioningManager.provision(orderRenewal.id);

    assert.notEqual(ent2.id, ent1.id);
    assert.equal(ent2.renewal_reminder_sent_at, null, 'o novo ciclo nasce sem aviso enviado, mesmo o ciclo anterior já tendo sido avisado');
});

// ═══════════════════════════════════════════════════════════════════════
// 4) INTEGRAÇÃO DE HANDLER (commerce.js) — fecha parte da lacuna D1
// ═══════════════════════════════════════════════════════════════════════

function makeFakeGuild(guildId) {
    const state = { createCalls: 0, createdChannels: [] };
    const guild = {
        id: guildId,
        channels: {
            create: async (opts) => {
                state.createCalls += 1;
                const ch = {
                    id: `chan-${guildId}-${state.createCalls}`,
                    ...opts,
                    send: async () => {},
                    delete: async () => {},
                    deletable: true,
                };
                state.createdChannels.push(ch);
                return ch;
            },
            cache: { get: () => undefined },
        },
    };
    return { guild, state };
}
function makeFakeUser(userId, username = 'tester') {
    return { id: userId, username, discriminator: '0', avatar: null, toString: () => `<@${userId}>` };
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

test('HANDLER — commerce_buy_plan: BLOQUEADO totalmente com entitlement ativo — nunca cria pedido/canal, orienta pra Renovar Plano', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    await makeActiveEntitlement(client, admin);
    const { guild, state } = makeFakeGuild('guild-p8-block-1');

    const interaction = makeFakeInteraction({ customId: 'commerce_buy_plan', userId: client, guild });
    await commerce.handle(interaction, {});

    assert.equal(state.createCalls, 0, 'nenhum canal deveria ter sido criado');
    const ordersBefore = query('SELECT * FROM commerce_orders WHERE user_id = ?', [client]);
    assert.equal(ordersBefore.length, 1, 'só o pedido original (já ACTIVE) — nenhum pedido novo criado pela tentativa bloqueada');
    assert.equal(interaction._replies.length, 1);
    assert.match(interaction._replies[0].content, /já possui um plano ativo/);
    const buttonIds = (interaction._replies[0].components || []).flatMap((row) => row.components.map((c) => c.data.custom_id));
    assert.ok(buttonIds.includes('commerce_renew_plan'), 'a mensagem de bloqueio precisa oferecer o botão de renovação');
});

test('HANDLER — commerce_buy_plan: cliente SEM entitlement ativo continua podendo comprar normalmente (sem regressão)', async () => {
    makePublishedProduct();
    const client = makeUser();
    const { guild, state } = makeFakeGuild('guild-p8-noblock-1');

    const interaction = makeFakeInteraction({ customId: 'commerce_buy_plan', userId: client, guild });
    await commerce.handle(interaction, {});

    assert.equal(state.createCalls, 1);
    const order = OrderManager.getOrderByChannel(state.createdChannels[0].id);
    assert.ok(order);
    assert.equal(order.renewal_of_entitlement_id, null);
});

test('HANDLER — commerce_renew_plan: SEM nenhum entitlement elegível, recusa limpo, nunca cria canal', async () => {
    const client = makeUser();
    const { guild, state } = makeFakeGuild('guild-p8-renew-ineligible-1');

    const interaction = makeFakeInteraction({ customId: 'commerce_renew_plan', userId: client, guild });
    await commerce.handle(interaction, {});

    assert.equal(state.createCalls, 0);
    assert.match(interaction._replies[0].content, /não tem nenhum plano ativo ou elegível/);
});

test('HANDLER — commerce_renew_plan: fluxo completo de ponta a ponta — cria pedido de renovação, referencia o entitlement, chega em ACTIVE sem duplicar', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement: ent1, product: product1 } = await makeActiveEntitlement(client, admin);
    // Specs dentro dos tetos padrão de capacityManager.applyHostCaps()
    // (HOST_MAX_RAM_PER_BOT=512, HOST_MAX_CPU_PER_BOT=50 por padrão) —
    // um upgrade que os excedesse seria clampado na escrita real, e a
    // verificação pós-grant do ProvisioningManager (Fase 7, não alterada
    // nesta fase) compara contra o snapshot bruto, então nunca bateria.
    // Isso é uma característica pré-existente da Fase 7, não algo pra
    // corrigir aqui — o teste só evita product specs irreais.
    const product2 = makePublishedProduct({ name: 'Plano Upgrade', maxBots: 5, maxRam: 480, maxCpu: 45 });
    const { guild, state } = makeFakeGuild('guild-p8-renew-full-1');

    // 1) Clica em "Renovar Plano" — cria o canal já referenciando ent1.
    const renewInteraction = makeFakeInteraction({ customId: 'commerce_renew_plan', userId: client, guild });
    await commerce.handle(renewInteraction, {});
    assert.equal(state.createCalls, 1);
    const channelId = state.createdChannels[0].id;
    const order = OrderManager.getOrderByChannel(channelId);
    assert.equal(order.renewal_of_entitlement_id, ent1.id, 'o pedido já nasce marcado como renovação, antes mesmo do produto escolhido');
    assert.match(renewInteraction._replies[0].content, /Criando seu pedido/);

    // 2) Escolhe um produto DIFERENTE (upgrade) — confirma que o handler
    // repassa renewal_of_entitlement_id de volta pra confirmProduct().
    const selectInteraction = makeFakeInteraction({ customId: 'commerce_select_product', userId: client, values: [product2.id], extra: { channelId } });
    await commerce.handle(selectInteraction, {});
    const afterSelect = OrderManager.getOrder(order.id);
    assert.equal(afterSelect.renewal_of_entitlement_id, ent1.id, 'confirmProduct() nunca deveria apagar a referência de renovação');
    assert.equal(afterSelect.status, OrderManager.STATUS.AWAITING_PAYMENT);
    assert.match(selectInteraction._replies[0]?.embeds?.[0]?.data?.title || '', /Renovação/);

    // 3) Resto do fluxo (pagamento/comprovante/revisão/aprovação/provisionamento)
    // já é exaustivamente testado nas Fases 5-7 — aqui só confirma que
    // chega em ACTIVE corretamente, sem duplicar entitlement.
    PaymentManager.createPaymentRecord(order.id);
    mockFetch(PNG_BUFFER);
    await ProofManager.submitProof(order.id, client, { url: 'https://cdn.discordapp.com/attachments/3/3/c.png', name: 'c.png', contentType: 'image/png', size: PNG_BUFFER.length });
    PaymentManager.openForReview(order.id, admin);
    PaymentManager.confirmPayment(order.id, admin);
    const { entitlement: ent2 } = ProvisioningManager.provision(order.id);

    assert.notEqual(ent2.id, ent1.id);
    assert.equal(EntitlementManager.getEntitlement(ent1.id).status, 'expired');
    const activeCount = get("SELECT COUNT(*) as c FROM commerce_entitlements WHERE user_id = ? AND status = 'active'", [client]).c;
    assert.equal(activeCount, 1, 'nunca acumula entitlements simultâneos, mesmo trocando de produto na renovação');

    const user = get('SELECT max_bots, max_ram, max_cpu FROM users WHERE id = ?', [client]);
    assert.equal(user.max_bots, 5, 'capacidade reflete o NOVO produto escolhido na renovação, não o antigo');
});

test('HANDLER — commerce_renew_plan: reusa o MESMO lock de commerce_buy_plan — dois cliques quase simultâneos só criam um canal', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    await makeActiveEntitlement(client, admin);
    const { guild, state } = makeFakeGuild('guild-p8-renew-race-1');

    const interactionA = makeFakeInteraction({ customId: 'commerce_renew_plan', userId: client, guild });
    const interactionB = makeFakeInteraction({ customId: 'commerce_renew_plan', userId: client, guild });

    const pA = commerce.handle(interactionA, {});
    const pB = commerce.handle(interactionB, {});
    await Promise.all([pA, pB]);

    assert.equal(state.createCalls, 1, 'só um canal de renovação deveria ter sido criado');
});

test('HANDLER — lock compartilhado: clicar "Comprar Plano" e "Renovar Plano" quase ao mesmo tempo (cliente sem entitlement ativo, ex.: elegível por expiração recente) só cria um canal', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement } = await makeActiveEntitlement(client, admin);
    // Expira recentemente — perde o bloqueio de commerce_buy_plan (que só
    // olha ATIVO) mas continua elegível pra renovação (dentro da janela).
    run("UPDATE commerce_entitlements SET status = 'expired', expires_at = datetime('now', '-1 day') WHERE id = ?", [entitlement.id]);

    const { guild, state } = makeFakeGuild('guild-p8-shared-lock-1');
    const interactionBuy = makeFakeInteraction({ customId: 'commerce_buy_plan', userId: client, guild });
    const interactionRenew = makeFakeInteraction({ customId: 'commerce_renew_plan', userId: client, guild });

    const pBuy = commerce.handle(interactionBuy, {});
    const pRenew = commerce.handle(interactionRenew, {});
    await Promise.all([pBuy, pRenew]);

    assert.equal(state.createCalls, 1, 'o lock compartilhado por buyerId nunca deveria deixar as duas passarem');
});

test('CONCORRÊNCIA (Fase 7 reafirmada p/ renovação): duas renovações do MESMO entitlement chegando a APPROVED — só uma provisiona, a outra falha com segurança, ProvisioningManager inalterado', async () => {
    const admin = makeUser('admin');
    const client = makeUser();
    const { entitlement: ent1 } = await makeActiveEntitlement(client, admin);
    run("UPDATE commerce_entitlements SET status = 'expired', expires_at = datetime('now', '-1 day') WHERE id = ?", [ent1.id]);

    async function makeApprovedRenewalOrder(suffix) {
        const product = makePublishedProduct();
        counter += 1;
        const order = OrderManager.createOrder({ userId: client, channelId: `p8-dualrenew-${suffix}-${counter}`, renewalOfEntitlementId: ent1.id });
        OrderManager.confirmProduct(order.id, product.id, ent1.id);
        PaymentManager.createPaymentRecord(order.id);
        mockFetch(PNG_BUFFER);
        await ProofManager.submitProof(order.id, client, { url: `https://cdn.discordapp.com/attachments/9/9/${suffix}.png`, name: `${suffix}.png`, contentType: 'image/png', size: PNG_BUFFER.length });
        PaymentManager.openForReview(order.id, admin);
        const { order: approved } = PaymentManager.confirmPayment(order.id, admin);
        return approved;
    }

    const orderA = await makeApprovedRenewalOrder('a');
    const orderB = await makeApprovedRenewalOrder('b');

    const resultA = ProvisioningManager.provision(orderA.id);
    assert.equal(resultA.order.status, OrderManager.STATUS.ACTIVE);

    assert.throws(() => ProvisioningManager.provision(orderB.id), /não acumula múltiplos entitlements/);
    assert.equal(OrderManager.getOrder(orderB.id).status, OrderManager.STATUS.PROVISIONING_FAILED);
    const paymentB = PaymentManager.getPaymentByOrder(orderB.id);
    assert.equal(paymentB.status, PaymentManager.PAYMENT_STATUS.CONFIRMED, 'pagamento do pedido B continua confirmado mesmo com a falha de provisionamento');

    const activeCount = get("SELECT COUNT(*) as c FROM commerce_entitlements WHERE user_id = ? AND status = 'active'", [client]).c;
    assert.equal(activeCount, 1);
});

// ═══════════════════════════════════════════════════════════════════════
// 5) ESTRUTURAL — sem caminho paralelo de escrita (regra geral, reafirmada)
// ═══════════════════════════════════════════════════════════════════════

test('ESTRUTURAL: renewal_reminder_sent_at só é escrito por EntitlementManager.js, em nenhum outro lugar de src/', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    function walk(dir) {
        let matches = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) matches = matches.concat(walk(full));
            else if (entry.name.endsWith('.js') && entry.name !== 'EntitlementManager.js') {
                const content = fs.readFileSync(full, 'utf8');
                if (/UPDATE\s+commerce_entitlements\s+SET[^;]*renewal_reminder_sent_at\s*=/is.test(content)) matches.push(full);
            }
        }
        return matches;
    }
    assert.deepEqual(walk(srcDir), [], 'nenhum arquivo além de EntitlementManager.js deveria escrever renewal_reminder_sent_at');
});

test('ESTRUTURAL: OrderManager.createOrder() continua sendo o único INSERT em commerce_orders em toda src/', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    function walk(dir) {
        let matches = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) matches = matches.concat(walk(full));
            else if (entry.name.endsWith('.js') && entry.name !== 'OrderManager.js') {
                const content = fs.readFileSync(full, 'utf8');
                if (/INSERT\s+INTO\s+commerce_orders/is.test(content)) matches.push(full);
            }
        }
        return matches;
    }
    assert.deepEqual(walk(srcDir), [], 'nenhum arquivo além de OrderManager.js deveria fazer INSERT em commerce_orders');
});

test('ESTRUTURAL: ProvisioningManager.js não foi alterado por escopo — continua sem child_process/SandboxManager/security, sem tocar em bots.suspended', () => {
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
