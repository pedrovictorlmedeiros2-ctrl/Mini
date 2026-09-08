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
function makeProduct(overrides = {}) {
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

test('saveProduct: cria um produto novo com defaults sensatos (billing mensal, ativo)', () => {
    const product = makeProduct();
    assert.equal(product.billing_period, 'monthly');
    assert.equal(product.status, 'active');
    assert.equal(product.storage, 1024);
});

test('saveProduct: rejeita billing_period fora de "monthly" (único válido na v1)', () => {
    assert.throws(() => makeProduct({ billingPeriod: 'yearly' }), /billingPeriod inválido/);
});

test('saveProduct: rejeita price não-numérico ou negativo', () => {
    assert.throws(() => makeProduct({ price: 'grátis' }));
    assert.throws(() => makeProduct({ price: -10 }));
});

test('saveProduct: ON CONFLICT atualiza o produto existente (mesmo id) em vez de duplicar', () => {
    const product = makeProduct({ id: 'prod-fixed', price: 10 });
    const updated = ProductCatalog.saveProduct({ ...product, price: 20, maxBots: product.max_bots, maxRam: product.max_ram, maxCpu: product.max_cpu, name: product.name });
    assert.equal(updated.id, product.id);
    assert.equal(updated.price, 20);
    assert.equal(ProductCatalog.getAllProducts(false).filter(p => p.id === 'prod-fixed').length, 1);
});

test('getAllProducts(true): nunca retorna produto arquivado', () => {
    const active = makeProduct();
    const archived = makeProduct();
    ProductCatalog.archiveProduct(archived.id);

    const activeList = ProductCatalog.getAllProducts(true);
    assert.ok(activeList.some(p => p.id === active.id));
    assert.ok(!activeList.some(p => p.id === archived.id));

    const allList = ProductCatalog.getAllProducts(false);
    assert.ok(allList.some(p => p.id === archived.id), 'getAllProducts(false) ainda deveria listar o arquivado');
});

test('archiveProduct: nunca apaga a linha — só muda status', () => {
    const product = makeProduct();
    const archived = ProductCatalog.archiveProduct(product.id);
    assert.equal(archived.status, 'archived');
    assert.ok(ProductCatalog.getProduct(product.id), 'a linha ainda deveria existir depois de arquivada');
});

test('buildProductSnapshot: contém TODOS os campos comercialmente relevantes, não só o preço', () => {
    const product = makeProduct({ description: 'Plano de teste', roleToAdd: 'role-123' });
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

test('buildProductSnapshot: nunca monta snapshot de um produto arquivado', () => {
    const product = makeProduct();
    ProductCatalog.archiveProduct(product.id);
    assert.throws(() => ProductCatalog.buildProductSnapshot(product.id), /não está disponível/);
});

test('buildProductSnapshot: lança para produto inexistente', () => {
    assert.throws(() => ProductCatalog.buildProductSnapshot('produto-que-nao-existe'), /não encontrado/);
});

test('IMUTABILIDADE: um snapshot já tirado nunca muda mesmo que o produto seja editado depois', () => {
    const product = makeProduct({ price: 50 });
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
