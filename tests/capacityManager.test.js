const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-capacityManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get } = require('../src/database/database');
initDatabase();

const config = require('../config');
const capacityManager = require('../src/managers/capacityManager');
const { activateUserPlan, savePlan, getPlan } = require('../src/managers/planManager');
const ProductCatalog = require('../src/managers/commerce/ProductCatalog');
const OrderManager = require('../src/managers/commerce/OrderManager');
const EntitlementManager = require('../src/managers/commerce/EntitlementManager');

let counter = 0;
function makeUser() {
    counter += 1;
    const userId = `capmgr-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', 'client']);
    return userId;
}
function makeLegacyPlan(overrides = {}) {
    counter += 1;
    const id = `capmgr-legacy-plan-${counter}`;
    savePlan({ id, name: 'Legado', price: 10, max_bots: 4, max_ram: 400, max_cpu: 30, ...overrides });
    return getPlan(id); // savePlan() (legado, não alterado nesta fase) não retorna o registro criado
}
function makeCommerceProductAndEntitlement(userId, overrides = {}) {
    counter += 1;
    const draftProduct = ProductCatalog.saveProduct({ id: `capmgr-prod-${counter}`, name: 'Novo', price: 20, maxBots: 7, maxRam: 700, maxCpu: 45, ...overrides });
    const product = ProductCatalog.publishProduct(draftProduct.id);
    const order = OrderManager.createOrder({ userId, channelId: `capmgr-channel-${counter}` });
    OrderManager.confirmProduct(order.id, product.id);
    run("UPDATE commerce_orders SET status = 'PROVISIONING' WHERE id = ?", [order.id]);
    return EntitlementManager.grant(order.id);
}

test('SEM plano legado e SEM entitlement: capacidade cai pro default/free (config.security.*)', () => {
    const userId = makeUser();
    capacityManager.recomputeUserCapacity(userId);
    const user = get('SELECT * FROM users WHERE id = ?', [userId]);
    assert.equal(user.max_bots, config.security.maxBotsPerUser);
    assert.equal(user.max_ram, config.security.maxRamPerBot);
    assert.equal(user.max_cpu, config.security.maxCpuPerBot);
});

test('SÓ plano legado (plan_id, sem entitlement): capacidade vem da tabela plans — legado 100% preservado', async () => {
    const userId = makeUser();
    const plan = makeLegacyPlan({ max_bots: 6, max_ram: 480, max_cpu: 35 });
    await activateUserPlan(userId, plan.id, null, null);

    const user = get('SELECT * FROM users WHERE id = ?', [userId]);
    assert.equal(user.plan_id, plan.id);
    assert.equal(user.max_bots, 6);
    assert.equal(user.max_ram, 480);
    assert.equal(user.max_cpu, 35);
});

test('SÓ entitlement (novo sistema, sem plan_id): capacidade vem do product_snapshot do Entitlement', () => {
    const userId = makeUser();
    makeCommerceProductAndEntitlement(userId, { maxBots: 5, maxRam: 450, maxCpu: 40 });

    const user = get('SELECT * FROM users WHERE id = ?', [userId]);
    assert.equal(user.plan_id, null);
    assert.equal(user.max_bots, 5);
    assert.equal(user.max_ram, 450);
    assert.equal(user.max_cpu, 40);
});

test('DECISÃO DE PRECEDÊNCIA: usuário com plan_id legado E entitlement ativo — Entitlement SEMPRE vence, nunca o legado', async () => {
    const userId = makeUser();
    const legacyPlan = makeLegacyPlan({ max_bots: 2, max_ram: 200, max_cpu: 20 });
    await activateUserPlan(userId, legacyPlan.id, null, null);

    let user = get('SELECT * FROM users WHERE id = ?', [userId]);
    assert.equal(user.max_bots, 2, 'sanity check: legado aplicado primeiro');

    // Usuário agora também ganha um Entitlement do sistema novo — sem
    // remover plan_id (simula exatamente o cenário de transição: alguém
    // que já tinha plano legado agora compra pelo fluxo novo). Valores
    // deliberadamente abaixo do teto de host default (512MB/50%/10 bots).
    makeCommerceProductAndEntitlement(userId, { maxBots: 9, maxRam: 480, maxCpu: 45 });

    user = get('SELECT * FROM users WHERE id = ?', [userId]);
    assert.equal(user.plan_id, legacyPlan.id, 'plan_id legado continua setado — não apagamos histórico');
    assert.equal(user.max_bots, 9, 'mas a CAPACIDADE agora vem do Entitlement, nunca do plano legado');
    assert.equal(user.max_ram, 480);
    assert.equal(user.max_cpu, 45);
});

test('DECISÃO DE PRECEDÊNCIA: entitlement expira — capacidade VOLTA pro plan_id legado (nunca fica travada no valor antigo do entitlement)', async () => {
    const userId = makeUser();
    const legacyPlan = makeLegacyPlan({ max_bots: 3, max_ram: 300, max_cpu: 25 });
    await activateUserPlan(userId, legacyPlan.id, null, null);

    const entitlement = makeCommerceProductAndEntitlement(userId, { maxBots: 8, maxRam: 800, maxCpu: 55 });
    assert.equal(get('SELECT max_bots FROM users WHERE id = ?', [userId]).max_bots, 8);

    EntitlementManager.expireEntitlement(entitlement.id);

    const user = get('SELECT * FROM users WHERE id = ?', [userId]);
    assert.equal(user.max_bots, 3, 'sem entitlement ativo, volta a valer o plan_id legado');
    assert.equal(user.max_ram, 300);
    assert.equal(user.max_cpu, 25);
});

test('NUNCA duas fontes de verdade concorrentes: nenhum código fora de capacityManager.js escreve em users.max_bots/max_ram/max_cpu', () => {
    const filesToCheck = [
        path.join(__dirname, '..', 'src', 'managers', 'planManager.js'),
        path.join(__dirname, '..', 'src', 'managers', 'commerce', 'EntitlementManager.js'),
    ];
    const directWrite = /UPDATE\s+users\s+SET[^;]*\bmax_(bots|ram|cpu)\s*=/is;
    for (const file of filesToCheck) {
        const src = fs.readFileSync(file, 'utf8');
        assert.equal(directWrite.test(src), false, `${path.basename(file)} não deveria escrever em max_bots/max_ram/max_cpu diretamente — só capacityManager.js`);
    }
});

test('TETO DE HOST: aplicado uma única vez, em capacityManager — nem o legado nem o novo sistema conseguem exceder', async () => {
    const originalRamCap = process.env.HOST_MAX_RAM_PER_BOT;
    process.env.HOST_MAX_RAM_PER_BOT = '500';
    try {
        const userLegacy = makeUser();
        const bigLegacyPlan = makeLegacyPlan({ max_ram: 99999 });
        await activateUserPlan(userLegacy, bigLegacyPlan.id, null, null);
        assert.equal(get('SELECT max_ram FROM users WHERE id = ?', [userLegacy]).max_ram, 500);

        const userNew = makeUser();
        makeCommerceProductAndEntitlement(userNew, { maxRam: 99999 });
        assert.equal(get('SELECT max_ram FROM users WHERE id = ?', [userNew]).max_ram, 500);
    } finally {
        if (originalRamCap === undefined) delete process.env.HOST_MAX_RAM_PER_BOT;
        else process.env.HOST_MAX_RAM_PER_BOT = originalRamCap;
    }
});

test('REGRESSÃO DO LEGADO: activateUserPlan continua gerenciando cargos do Discord normalmente (client opcional, sem quebrar)', async () => {
    const userId = makeUser();
    const plan = makeLegacyPlan();
    await assert.doesNotReject(() => activateUserPlan(userId, plan.id, null, null));
});

test('REGRESSÃO DO LEGADO: activateUserPlan lança pra plano inexistente, exatamente como antes', async () => {
    const userId = makeUser();
    await assert.rejects(() => activateUserPlan(userId, 'plano-que-nao-existe', null, null), /Plano não encontrado/);
});
