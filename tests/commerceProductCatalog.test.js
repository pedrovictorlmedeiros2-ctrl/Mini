const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commerceProductCatalog.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase } = require('../src/database/database');
initDatabase();

const ProductCatalog = require('../src/managers/commerce/ProductCatalog');

let counter = 0;
function makeDraftProduct(overrides = {}) {
    counter += 1;
    return ProductCatalog.saveProduct({
        id: `prod-${counter}`,
        name: `Plano ${counter}`,
        price: 29.9,
        maxBots: 2,
        maxRam: 512,
        maxCpu: 40,
        ...overrides,
    });
}
function makePublishedProduct(overrides = {}) {
    const product = makeDraftProduct(overrides);
    return ProductCatalog.publishProduct(product.id);
}

test('saveProduct: cria um produto novo SEMPRE como draft (nunca visível ao cliente até publicar explicitamente)', () => {
    const product = makeDraftProduct();
    assert.equal(product.billing_period, 'monthly');
    assert.equal(product.status, ProductCatalog.PRODUCT_STATUS.DRAFT);
    assert.equal(product.storage, 1024);
});

test('saveProduct: rejeita billing_period fora de "monthly" (único válido na v1)', () => {
    assert.throws(() => makeDraftProduct({ billingPeriod: 'yearly' }), /billingPeriod inválido/);
});

test('saveProduct: rejeita price não-numérico ou negativo', () => {
    assert.throws(() => makeDraftProduct({ price: 'grátis' }));
    assert.throws(() => makeDraftProduct({ price: -10 }));
});

// ═══════════════════════════════════════════════════════════════════════
// FASE 9 (hardening): specs acima do teto do host — produto estruturalmente invendível
// ═══════════════════════════════════════════════════════════════════════

test('saveProduct: rejeita RAM acima do teto do host (HOST_MAX_RAM_PER_BOT), antes de qualquer INSERT/UPDATE', () => {
    const originalRamCap = process.env.HOST_MAX_RAM_PER_BOT;
    process.env.HOST_MAX_RAM_PER_BOT = '500';
    try {
        assert.throws(() => makeDraftProduct({ id: 'prod-ram-over', maxRam: 900 }), /teto do host/);
        assert.equal(ProductCatalog.getProduct('prod-ram-over'), undefined, 'nada deveria ter sido gravado');
    } finally {
        if (originalRamCap === undefined) delete process.env.HOST_MAX_RAM_PER_BOT;
        else process.env.HOST_MAX_RAM_PER_BOT = originalRamCap;
    }
});

test('saveProduct: rejeita CPU acima do teto do host (HOST_MAX_CPU_PER_BOT)', () => {
    const originalCpuCap = process.env.HOST_MAX_CPU_PER_BOT;
    process.env.HOST_MAX_CPU_PER_BOT = '40';
    try {
        assert.throws(() => makeDraftProduct({ id: 'prod-cpu-over', maxCpu: 60 }), /teto do host/);
        assert.equal(ProductCatalog.getProduct('prod-cpu-over'), undefined);
    } finally {
        if (originalCpuCap === undefined) delete process.env.HOST_MAX_CPU_PER_BOT;
        else process.env.HOST_MAX_CPU_PER_BOT = originalCpuCap;
    }
});

test('saveProduct: rejeita quantidade de bots acima do teto do host (HOST_MAX_BOTS_PER_USER)', () => {
    const originalBotsCap = process.env.HOST_MAX_BOTS_PER_USER;
    process.env.HOST_MAX_BOTS_PER_USER = '3';
    try {
        assert.throws(() => makeDraftProduct({ id: 'prod-bots-over', maxBots: 7 }), /teto do host/);
        assert.equal(ProductCatalog.getProduct('prod-bots-over'), undefined);
    } finally {
        if (originalBotsCap === undefined) delete process.env.HOST_MAX_BOTS_PER_USER;
        else process.env.HOST_MAX_BOTS_PER_USER = originalBotsCap;
    }
});

test('saveProduct: specs EXATAMENTE no teto (nunca clampadas) são aceitas normalmente', () => {
    const originalRamCap = process.env.HOST_MAX_RAM_PER_BOT;
    process.env.HOST_MAX_RAM_PER_BOT = '500';
    try {
        assert.doesNotThrow(() => makeDraftProduct({ id: 'prod-ram-exact', maxRam: 500 }));
    } finally {
        if (originalRamCap === undefined) delete process.env.HOST_MAX_RAM_PER_BOT;
        else process.env.HOST_MAX_RAM_PER_BOT = originalRamCap;
    }
});

test('saveProduct: specs dentro do teto padrão (sem override de env) continuam sendo aceitas normalmente', () => {
    assert.doesNotThrow(() => makeDraftProduct({ id: 'prod-within-default', maxBots: 5, maxRam: 480, maxCpu: 45 }));
});

test('publishProduct: rejeita um produto DRAFT pré-existente cujas specs ficaram acima do teto (defesa em profundidade, mesmo se saveProduct() não tivesse rejeitado antes)', () => {
    // Simula um registro criado ANTES desta validação existir — grava
    // direto no banco, contornando saveProduct(), pra emular um dado
    // legado. publishProduct() precisa revalidar de qualquer forma.
    const { run } = require('../src/database/database');
    run(
        `INSERT INTO commerce_products (id, name, price, max_bots, max_ram, max_cpu, storage, billing_period, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['prod-legacy-over', 'Legado', 10, 2, 99999, 30, 1024, 'monthly', ProductCatalog.PRODUCT_STATUS.DRAFT]
    );
    assert.throws(() => ProductCatalog.publishProduct('prod-legacy-over'), /teto do host/);
    assert.equal(ProductCatalog.getProduct('prod-legacy-over').status, ProductCatalog.PRODUCT_STATUS.DRAFT, 'nunca deveria ter sido publicado');
});

test('publishProduct: continua funcionando normalmente pra um produto dentro do teto (sem regressão)', () => {
    const product = makeDraftProduct({ id: 'prod-publish-ok' });
    const published = ProductCatalog.publishProduct(product.id);
    assert.equal(published.status, ProductCatalog.PRODUCT_STATUS.PUBLISHED);
});

test('saveProduct: ON CONFLICT atualiza o produto existente (mesmo id) em vez de duplicar', () => {
    const product = makeDraftProduct({ id: 'prod-fixed', price: 10 });
    const updated = ProductCatalog.saveProduct({ ...product, price: 20, maxBots: product.max_bots, maxRam: product.max_ram, maxCpu: product.max_cpu, name: product.name });
    assert.equal(updated.id, product.id);
    assert.equal(updated.price, 20);
    assert.equal(ProductCatalog.getAllProducts().filter((p) => p.id === 'prod-fixed').length, 1);
});

test('saveProduct: EDITAR um produto nunca muda o status como efeito colateral (editar não republica nem despublica)', () => {
    const published = makePublishedProduct({ price: 10 });
    const editedStillPublished = ProductCatalog.saveProduct({ ...published, price: 15, maxBots: published.max_bots, maxRam: published.max_ram, maxCpu: published.max_cpu, name: published.name });
    assert.equal(editedStillPublished.status, ProductCatalog.PRODUCT_STATUS.PUBLISHED);
    assert.equal(editedStillPublished.price, 15);
});

// ────────────────────────────────────────────────────────────────────────
// CICLO DE VIDA: draft → published → paused → published/archived
// ────────────────────────────────────────────────────────────────────────

test('publishProduct: draft -> published', () => {
    const product = makeDraftProduct();
    const published = ProductCatalog.publishProduct(product.id);
    assert.equal(published.status, ProductCatalog.PRODUCT_STATUS.PUBLISHED);
});

test('pauseProduct: published -> paused; publishProduct: paused -> published de novo (republicação permitida)', () => {
    const product = makePublishedProduct();
    const paused = ProductCatalog.pauseProduct(product.id);
    assert.equal(paused.status, ProductCatalog.PRODUCT_STATUS.PAUSED);

    const republished = ProductCatalog.publishProduct(product.id);
    assert.equal(republished.status, ProductCatalog.PRODUCT_STATUS.PUBLISHED);
});

test('pauseProduct: nunca permitido a partir de draft ou archived — só de published', () => {
    const draft = makeDraftProduct();
    assert.throws(() => ProductCatalog.pauseProduct(draft.id));

    const archived = ProductCatalog.archiveProduct(makeDraftProduct().id);
    assert.throws(() => ProductCatalog.pauseProduct(archived.id));
});

test('publishProduct: nunca permitido a partir de archived (terminal)', () => {
    const product = makeDraftProduct();
    ProductCatalog.archiveProduct(product.id);
    assert.throws(() => ProductCatalog.publishProduct(product.id));
});

test('archiveProduct: permitido a partir de draft, published ou paused — nunca apaga a linha, só muda status', () => {
    const fromDraft = ProductCatalog.archiveProduct(makeDraftProduct().id);
    assert.equal(fromDraft.status, ProductCatalog.PRODUCT_STATUS.ARCHIVED);

    const fromPublished = ProductCatalog.archiveProduct(makePublishedProduct().id);
    assert.equal(fromPublished.status, ProductCatalog.PRODUCT_STATUS.ARCHIVED);

    const pausedProduct = makePublishedProduct();
    ProductCatalog.pauseProduct(pausedProduct.id);
    const fromPaused = ProductCatalog.archiveProduct(pausedProduct.id);
    assert.equal(fromPaused.status, ProductCatalog.PRODUCT_STATUS.ARCHIVED);

    assert.ok(ProductCatalog.getProduct(fromDraft.id), 'a linha ainda deveria existir depois de arquivada');
});

test('archiveProduct: terminal — nunca pode ser republicado nem re-arquivado a partir de archived', () => {
    const product = makeDraftProduct();
    ProductCatalog.archiveProduct(product.id);
    assert.throws(() => ProductCatalog.archiveProduct(product.id));
    assert.throws(() => ProductCatalog.publishProduct(product.id));
});

// ────────────────────────────────────────────────────────────────────────
// VISIBILIDADE: cliente só vê PUBLISHED (requisito explícito da loja)
// ────────────────────────────────────────────────────────────────────────

test('getPublishedProducts: SÓ retorna produtos published — nunca draft, paused ou archived', () => {
    const draft = makeDraftProduct();
    const published = makePublishedProduct();
    const paused = makePublishedProduct();
    ProductCatalog.pauseProduct(paused.id);
    const archived = makeDraftProduct();
    ProductCatalog.archiveProduct(archived.id);

    const visible = ProductCatalog.getPublishedProducts();
    const visibleIds = visible.map((p) => p.id);

    assert.ok(visibleIds.includes(published.id));
    assert.equal(visibleIds.includes(draft.id), false, 'draft nunca deveria aparecer pro cliente');
    assert.equal(visibleIds.includes(paused.id), false, 'paused nunca deveria aparecer pro cliente');
    assert.equal(visibleIds.includes(archived.id), false, 'archived nunca deveria aparecer pro cliente');
});

test('getAllProducts: lista TODOS os status — uso administrativo, nunca usado pra montar a loja pública', () => {
    const draft = makeDraftProduct();
    const archived = makeDraftProduct();
    ProductCatalog.archiveProduct(archived.id);

    const all = ProductCatalog.getAllProducts().map((p) => p.id);
    assert.ok(all.includes(draft.id));
    assert.ok(all.includes(archived.id));
});

// ────────────────────────────────────────────────────────────────────────
// SNAPSHOT: só produto PUBLISHED pode virar snapshot de um pedido
// ────────────────────────────────────────────────────────────────────────

test('buildProductSnapshot: contém TODOS os campos comercialmente relevantes, não só o preço', () => {
    const product = makePublishedProduct({ description: 'Plano de teste', roleToAdd: 'role-123' });
    const snapshot = ProductCatalog.buildProductSnapshot(product.id);

    assert.equal(snapshot.id, product.id);
    assert.equal(snapshot.name, product.name);
    assert.equal(snapshot.description, 'Plano de teste');
    assert.equal(snapshot.price, product.price);
    assert.equal(snapshot.maxBots, product.max_bots);
    assert.equal(snapshot.maxRam, product.max_ram);
    assert.equal(snapshot.maxCpu, product.max_cpu);
    assert.equal(snapshot.billingPeriod, 'monthly');
    assert.equal(snapshot.roleToAdd, 'role-123');
    assert.ok(snapshot.snapshotAt);
});

test('buildProductSnapshot: nunca monta snapshot de um produto DRAFT (ainda não publicado)', () => {
    const product = makeDraftProduct();
    assert.throws(() => ProductCatalog.buildProductSnapshot(product.id), /não está disponível/);
});

test('buildProductSnapshot: nunca monta snapshot de um produto PAUSED', () => {
    const product = makePublishedProduct();
    ProductCatalog.pauseProduct(product.id);
    assert.throws(() => ProductCatalog.buildProductSnapshot(product.id), /não está disponível/);
});

test('buildProductSnapshot: nunca monta snapshot de um produto ARCHIVED', () => {
    const product = makeDraftProduct();
    ProductCatalog.archiveProduct(product.id);
    assert.throws(() => ProductCatalog.buildProductSnapshot(product.id), /não está disponível/);
});

test('buildProductSnapshot: lança para produto inexistente', () => {
    assert.throws(() => ProductCatalog.buildProductSnapshot('produto-que-nao-existe'), /não encontrado/);
});

test('IMUTABILIDADE: um snapshot já tirado nunca muda mesmo que o produto seja editado depois', () => {
    const product = makePublishedProduct({ price: 50 });
    const snapshot1 = ProductCatalog.buildProductSnapshot(product.id);
    assert.equal(snapshot1.price, 50);

    ProductCatalog.saveProduct({ ...product, price: 999, maxBots: product.max_bots, maxRam: product.max_ram, maxCpu: product.max_cpu, name: product.name });

    // O snapshot já tirado (objeto JS) nunca muda — é uma cópia.
    assert.equal(snapshot1.price, 50);
    // Um NOVO snapshot, sim, reflete a mudança (é assim que deveria ser —
    // a imutabilidade é do snapshot já GRAVADO num pedido, não do produto).
    const snapshot2 = ProductCatalog.buildProductSnapshot(product.id);
    assert.equal(snapshot2.price, 999);
});

test('IMUTABILIDADE: pausar o produto DEPOIS de tirar um snapshot nunca invalida o snapshot já gravado (ele é uma cópia congelada em JSON)', () => {
    const product = makePublishedProduct({ price: 77 });
    const snapshot = ProductCatalog.buildProductSnapshot(product.id);
    ProductCatalog.pauseProduct(product.id);

    // O snapshot é só um objeto JS já retornado — continua intacto.
    assert.equal(snapshot.price, 77);
});
