/**
 * TESTES ADVERSARIAIS — FASE 4 (fluxo público de compra no Discord)
 *
 * Foco desta fase, sobre o que já existia (Fase 3):
 *   1) "Ver detalhes" por plano — recurso novo, revalida PUBLISHED no
 *      momento do clique (nunca confia que o menu ainda reflete a
 *      realidade).
 *   2) Corrida de duplo pedido em commerce_buy_plan — corrigida com um
 *      lock em memória síncrono; testada aqui invocando o handler real
 *      (commerce.handle) duas vezes sem aguardar entre as chamadas, o
 *      jeito mais fiel de reproduzir dois cliques quase simultâneos.
 *   3) Corrida de duplo comprovante em commerce_send_proof — mesma
 *      técnica, provando que só um MessageCollector é criado por pedido.
 *   4) Canal privado do pedido: overwrites corretos (nega @everyone,
 *      libera só o comprador + cargo de staff configurado).
 *   5) Staff revogado tentando agir — negado já na camada de UI.
 *
 * Usa dublês mínimos de guild/interaction do discord.js — só os métodos
 * que o código de src/handlers/domains/commerce.js realmente chama.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commercePhase4Adversarial.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get, query } = require('../src/database/database');
initDatabase();

const config = require('../config');

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const CommerceStaffManager = require('../src/managers/commerce/CommerceStaffManager');
const CommerceConfig = require('../src/managers/commerce/CommerceConfig');
const commerce = require('../src/handlers/domains/commerce');

let counter = 0;
function makeUser(role = 'client') {
    counter += 1;
    const userId = `p4-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', role]);
    return userId;
}
function makePublishedProduct(overrides = {}) {
    counter += 1;
    const draft = ProductCatalog.saveProduct({ id: `p4-prod-${counter}`, name: 'Plano Teste', price: 29.9, maxBots: 2, maxRam: 400, maxCpu: 30, storage: 1024, ...overrides });
    return ProductCatalog.publishProduct(draft.id);
}

function makeFakeGuild(guildId) {
    const state = { createCalls: 0, createdChannels: [] };
    const guild = {
        id: guildId,
        channels: {
            create: async (opts) => {
                state.createCalls += 1;
                // Prefixado pelo guildId (sempre único por teste) — evita
                // colidir com commerce_orders.channel_id (UNIQUE) de outro
                // teste que também começa a contar em "1".
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
        deferReply: async () => {},
        client: { users: { fetch: async () => ({ send: async () => {} }) } },
        // Default trivial — cobre handlers que chamam interaction.channel.*
        // (ex.: cancelamento agenda um delete() via setTimeout); `extra`
        // pode sobrescrever com um mock mais específico quando precisar.
        channel: { send: async () => {}, delete: async () => {} },
        _replies: replies,
        ...extra,
    };
}

function makeFakeChannelWithCollector() {
    const state = { createCalls: 0 };
    const channel = {
        send: async () => {},
        createMessageCollector: () => {
            state.createCalls += 1;
            const listeners = {};
            return {
                on(event, cb) { listeners[event] = cb; return this; },
                _emit(event, ...args) { if (listeners[event]) listeners[event](...args); },
            };
        },
    };
    return { channel, state };
}

// ═══════════════════════════════════════════════════════════════════════
// 1) "VER DETALHES" — revalida PUBLISHED no momento do clique
// ═══════════════════════════════════════════════════════════════════════

test('Painel de planos: lista mostra nome, preço, período e recursos/limites (inclusive storage)', async () => {
    const product = makePublishedProduct({ name: 'Plano Listagem', price: 15.5, maxBots: 3, maxRam: 300, maxCpu: 25, storage: 2048 });
    const interaction = makeFakeInteraction({ customId: 'commerce_view_plans', userId: makeUser() });

    await commerce.handle(interaction, {});
    assert.equal(interaction._replies.length, 1);
    const desc = interaction._replies[0].embeds[0].data.description;
    assert.match(desc, /Plano Listagem/);
    assert.match(desc, /R\$ 15\.50\/mês/);
    assert.match(desc, /3 bot\(s\)/);
    assert.match(desc, /300MB RAM/);
    assert.match(desc, /25% CPU/);
    assert.match(desc, /2048MB/);
});

test('Ver detalhes: mostra descrição, preço/período e recursos completos (incluindo armazenamento) de um plano PUBLISHED', async () => {
    const product = makePublishedProduct({ name: 'Plano Detalhado', description: 'Ótimo pra começar.', storage: 4096 });
    const interaction = makeFakeInteraction({ customId: 'commerce_view_plan_details', userId: makeUser(), values: [product.id] });

    await commerce.handle(interaction, {});
    assert.equal(interaction._replies.length, 1);
    const desc = interaction._replies[0].embeds[0].data.description;
    assert.match(desc, /Ótimo pra começar\./);
    assert.match(desc, /4096MB armazenamento/);
});

test('Ver detalhes: produto pausado/arquivado DEPOIS do menu montado é recusado no clique (revalidação, nunca confia no menu)', async () => {
    const product = makePublishedProduct({ name: 'Plano Instável' });
    ProductCatalog.pauseProduct(product.id); // simula mudança de estado entre a montagem do menu e o clique

    const interaction = makeFakeInteraction({ customId: 'commerce_view_plan_details', userId: makeUser(), values: [product.id] });
    await commerce.handle(interaction, {});

    assert.equal(interaction._replies.length, 1);
    assert.match(interaction._replies[0].content, /não está mais disponível/);
});

test('Ver detalhes: um productId inexistente/forjado nunca crasha — resposta de erro clara', async () => {
    const interaction = makeFakeInteraction({ customId: 'commerce_view_plan_details', userId: makeUser(), values: ['produto-que-nao-existe'] });
    await commerce.handle(interaction, {});
    assert.equal(interaction._replies.length, 1);
    assert.match(interaction._replies[0].content, /não está mais disponível/);
});

// ═══════════════════════════════════════════════════════════════════════
// 2) CONCORRÊNCIA — duplo pedido em commerce_buy_plan
// ═══════════════════════════════════════════════════════════════════════

test('CONCORRÊNCIA: dois cliques quase simultâneos em "Comprar Plano" do MESMO cliente — só um canal/pedido é criado', async () => {
    makePublishedProduct();
    const userId = makeUser();
    const { guild, state } = makeFakeGuild('guild-race-1');

    const interactionA = makeFakeInteraction({ customId: 'commerce_buy_plan', userId, guild });
    const interactionB = makeFakeInteraction({ customId: 'commerce_buy_plan', userId, guild });

    // Chamadas disparadas SEM aguardar uma pela outra — reproduz o
    // clique duplo real (duas invocações de handle() concorrentes).
    const pA = commerce.handle(interactionA, {});
    const pB = commerce.handle(interactionB, {});
    await Promise.all([pA, pB]);

    assert.equal(state.createCalls, 1, 'só um canal de pedido deveria ter sido criado');
    const orders = query('SELECT * FROM commerce_orders WHERE user_id = ?', [userId]);
    assert.equal(orders.length, 1, 'só um pedido deveria existir pro cliente depois da corrida');

    // A segunda tentativa recebeu uma resposta explícita, nunca silêncio.
    const allReplies = [...interactionA._replies, ...interactionB._replies];
    assert.ok(allReplies.some((r) => /processando seu pedido|pedido em andamento|Pedido criado/.test(r.content || '')));
});

test('CONCORRÊNCIA: dois cliques do MESMO cliente em momentos totalmente diferentes (não concorrentes) — o segundo é bloqueado pelo pedido já em andamento, não pela corrida', async () => {
    makePublishedProduct();
    const userId = makeUser();
    const { guild, state } = makeFakeGuild('guild-sequential-1');

    const interactionA = makeFakeInteraction({ customId: 'commerce_buy_plan', userId, guild });
    await commerce.handle(interactionA, {});

    const interactionB = makeFakeInteraction({ customId: 'commerce_buy_plan', userId, guild });
    await commerce.handle(interactionB, {});

    assert.equal(state.createCalls, 1);
    assert.match(interactionB._replies[0].content, /já possui um pedido em andamento/);
});

// ═══════════════════════════════════════════════════════════════════════
// 3) CANAL PRIVADO DO PEDIDO — overwrites corretos
// ═══════════════════════════════════════════════════════════════════════

test('CANAL PRIVADO: nega @everyone, libera só o comprador e o cargo de staff configurado — nunca outro cliente', async () => {
    makePublishedProduct();
    CommerceConfig.saveChannelStructure({ staff_role_id: 'role-staff-overwrite-test' });
    const userId = makeUser();
    const { guild, state } = makeFakeGuild('guild-overwrite-1');

    const interaction = makeFakeInteraction({ customId: 'commerce_buy_plan', userId, guild });
    await commerce.handle(interaction, {});

    assert.equal(state.createdChannels.length, 1);
    const overwrites = state.createdChannels[0].permissionOverwrites;
    const everyoneRule = overwrites.find((o) => o.id === guild.id);
    const buyerRule = overwrites.find((o) => o.id === userId);
    const staffRule = overwrites.find((o) => o.id === 'role-staff-overwrite-test');

    assert.ok(everyoneRule && everyoneRule.deny && everyoneRule.deny.length > 0, '@everyone precisa ser explicitamente negado');
    assert.ok(buyerRule && buyerRule.allow && buyerRule.allow.length > 0, 'o comprador precisa conseguir ver o próprio canal');
    assert.ok(staffRule, 'o cargo de staff configurado precisa estar no overwrite (visibilidade operacional)');
    // Nenhum outro ID (ex.: outro cliente qualquer) aparece na lista.
    assert.equal(overwrites.length, 3);
});

test('CANAL PRIVADO: sem staff_role_id configurado, overwrite nunca referencia um cargo inexistente', async () => {
    makePublishedProduct();
    CommerceConfig.saveChannelStructure({ staff_role_id: null });
    const userId = makeUser();
    const { guild, state } = makeFakeGuild('guild-overwrite-2');

    const interaction = makeFakeInteraction({ customId: 'commerce_buy_plan', userId, guild });
    await commerce.handle(interaction, {});

    const overwrites = state.createdChannels[0].permissionOverwrites;
    assert.equal(overwrites.length, 2, 'sem staff_role_id, só @everyone e o comprador deveriam ter overwrite');
});

// ═══════════════════════════════════════════════════════════════════════
// 4) CONCORRÊNCIA — duplo comprovante em commerce_send_proof
// ═══════════════════════════════════════════════════════════════════════

test('CONCORRÊNCIA: dois cliques quase simultâneos em "Enviar Comprovante" pro MESMO pedido — só um MessageCollector é criado', async () => {
    const userId = makeUser();
    const product = makePublishedProduct();
    counter += 1;
    const channelId = `p4-proof-race-chan-${counter}`;
    const order = OrderManager.createOrder({ userId, channelId });
    OrderManager.confirmProduct(order.id, product.id);

    const { channel: channelA, state: stateA } = makeFakeChannelWithCollector();
    const { channel: channelB, state: stateB } = makeFakeChannelWithCollector();

    const interactionA = makeFakeInteraction({ customId: 'commerce_send_proof', userId, extra: { channelId, channel: channelA } });
    const interactionB = makeFakeInteraction({ customId: 'commerce_send_proof', userId, extra: { channelId, channel: channelB } });

    const pA = commerce.handle(interactionA, {});
    const pB = commerce.handle(interactionB, {});
    await Promise.all([pA, pB]);

    assert.equal(stateA.createCalls + stateB.createCalls, 1, 'só um MessageCollector deveria ter sido criado para o mesmo pedido');
    const allReplies = [...interactionA._replies, ...interactionB._replies];
    assert.ok(allReplies.some((r) => /já estamos aguardando seu comprovante/i.test(r.content || '')), 'a segunda tentativa deveria ser recusada explicitamente, nunca silenciosa');
});

test('CONCORRÊNCIA: após o collector do pedido encerrar (fim natural), um novo envio de comprovante não é bloqueado', async () => {
    const userId = makeUser();
    const product = makePublishedProduct();
    counter += 1;
    const channelId = `p4-proof-reopen2-chan-${counter}`;
    const order = OrderManager.createOrder({ userId, channelId });
    OrderManager.confirmProduct(order.id, product.id);

    let lastCollector = null;
    const channel = {
        send: async () => {},
        createMessageCollector: () => {
            const listeners = {};
            lastCollector = {
                on(event, cb) { listeners[event] = cb; return lastCollector; },
                _emit(event, ...args) { if (listeners[event]) listeners[event](...args); },
            };
            return lastCollector;
        },
    };

    const interaction1 = makeFakeInteraction({ customId: 'commerce_send_proof', userId, extra: { channelId, channel } });
    await commerce.handle(interaction1, {});
    assert.ok(lastCollector);
    lastCollector._emit('end'); // simula timeout/fim natural do collector

    const interaction2 = makeFakeInteraction({ customId: 'commerce_send_proof', userId, extra: { channelId, channel } });
    await commerce.handle(interaction2, {});
    assert.equal(interaction2._replies.length, 1);
    assert.match(interaction2._replies[0].content, /Envie a imagem/, 'depois do "end", um novo pedido de comprovante deveria ser aceito normalmente');
});

// ═══════════════════════════════════════════════════════════════════════
// 5) STAFF REVOGADO — negado já na camada de UI (defesa em profundidade)
// ═══════════════════════════════════════════════════════════════════════

test('STAFF REVOGADO: usuário com COMMERCE_STAFF revogado é barrado já no handler ao tentar aprovar', async () => {
    const admin = makeUser('admin');
    const staff = makeUser();
    CommerceStaffManager.grant(staff, admin);
    CommerceStaffManager.revoke(staff, admin);
    assert.equal(CommerceStaffManager.hasCommercePermission(staff), false);

    const interaction = makeFakeInteraction({ customId: 'commerce_staff_approve_999999', userId: staff });
    await commerce.handle(interaction, {});
    assert.equal(interaction._replies.length, 1);
    assert.match(interaction._replies[0].content, /Acesso negado/);
});

test('STAFF REVOGADO: mesmo tentando ver a fila de pedidos, é barrado', async () => {
    const admin = makeUser('admin');
    const staff = makeUser();
    CommerceStaffManager.grant(staff, admin);
    CommerceStaffManager.revoke(staff, admin);

    const interaction = makeFakeInteraction({ customId: 'commerce_staff_queue', userId: staff });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /Acesso negado/);
});

// ═══════════════════════════════════════════════════════════════════════
// 6) IDOR / MANIPULAÇÃO — reafirmação no nível do handler (defesa em profundidade)
// ═══════════════════════════════════════════════════════════════════════

test('IDOR: cliente B não consegue selecionar produto no canal de pedido do cliente A', async () => {
    const clientA = makeUser();
    const clientB = makeUser();
    const product = makePublishedProduct();
    counter += 1;
    const channelId = `p4-idor-select-${counter}`;
    OrderManager.createOrder({ userId: clientA, channelId });

    const interaction = makeFakeInteraction({ customId: 'commerce_select_product', userId: clientB, values: [product.id], extra: { channelId } });
    await commerce.handle(interaction, {});
    assert.match(interaction._replies[0].content, /não é seu/);

    const order = OrderManager.getOrderByChannel(channelId);
    assert.equal(order.status, OrderManager.STATUS.DRAFT, 'o pedido do cliente A nunca deveria avançar por causa da tentativa do cliente B');
});

test('IDOR: cliente B não consegue cancelar o pedido do cliente A através do canal dele', async () => {
    const clientA = makeUser();
    const clientB = makeUser();
    counter += 1;
    const channelId = `p4-idor-cancel-${counter}`;
    const order = OrderManager.createOrder({ userId: clientA, channelId });

    const interaction = makeFakeInteraction({ customId: 'commerce_cancel_order', userId: clientB, extra: { channelId } });
    await commerce.handle(interaction, {});

    assert.equal(OrderManager.getOrder(order.id).status, OrderManager.STATUS.DRAFT, 'o pedido do cliente A nunca deveria ser cancelado por outro cliente');
});
