/**
 * PRODUCT CATALOG (Sistema Comercial — Fase 2)
 *
 * CRUD do catálogo de produtos (planos mensais de capacidade de
 * hospedagem, v1) e o construtor do snapshot imutável usado por
 * OrderManager.confirmProduct(). Ver COMMERCIAL_ARCHITECTURE_PROPOSAL.md
 * §2/§6.
 *
 * Nunca decide preço nem calcula desconto — isso é OrderManager +
 * CouponManager. Este módulo só sabe "o que é o produto agora".
 */
const { get, run, query } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');

const PRODUCT_STATUS = Object.freeze({ ACTIVE: 'active', ARCHIVED: 'archived' });
const VALID_BILLING_PERIODS = new Set(['monthly']); // v1: só mensal (decisão #3)

/**
 * Cria ou atualiza um produto. Nunca apaga — arquivar (archiveProduct) é
 * o único jeito de "remover" um produto do catálogo, porque pedidos
 * antigos continuam referenciando product_id pra fins de exibição
 * administrativa (o snapshot em si nunca depende disso continuar
 * existindo).
 */
function saveProduct(productData) {
    const {
        id, name, price, maxBots, maxRam, maxCpu,
        guildId = null,
        description = null,
        storage = 1024,
        billingPeriod = 'monthly',
        roleToAdd = null,
        roleToRemove = null,
        status = PRODUCT_STATUS.ACTIVE,
    } = productData;

    if (!id || !name) {
        throw new Error('ProductCatalog.saveProduct requer id e name.');
    }
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
        throw new Error('ProductCatalog.saveProduct requer um price numérico válido (>= 0).');
    }
    if (!VALID_BILLING_PERIODS.has(billingPeriod)) {
        throw new Error(`billingPeriod inválido: "${billingPeriod}". Válidos na v1: ${[...VALID_BILLING_PERIODS].join(', ')}.`);
    }

    const isNew = !get('SELECT id FROM commerce_products WHERE id = ?', [id]);

    run(`
        INSERT INTO commerce_products (id, guild_id, name, description, price, max_bots, max_ram, max_cpu, storage, billing_period, role_to_add, role_to_remove, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            guild_id=excluded.guild_id, name=excluded.name, description=excluded.description,
            price=excluded.price, max_bots=excluded.max_bots, max_ram=excluded.max_ram,
            max_cpu=excluded.max_cpu, storage=excluded.storage, billing_period=excluded.billing_period,
            role_to_add=excluded.role_to_add, role_to_remove=excluded.role_to_remove,
            status=excluded.status, updated_at=datetime('now')
    `, [id, guildId, name, description, price, maxBots, maxRam, maxCpu, storage, billingPeriod, roleToAdd, roleToRemove, status]);

    recordAuditEvent({
        userId: null,
        event: isNew ? 'commerce:product_created' : 'commerce:product_updated',
        details: JSON.stringify({ productId: id, name, price, status }),
        severity: 'info',
    });

    return getProduct(id);
}

function getProduct(productId) {
    return get('SELECT * FROM commerce_products WHERE id = ?', [productId]);
}

function getAllProducts(onlyActive = true) {
    if (onlyActive) {
        return query("SELECT * FROM commerce_products WHERE status = ? ORDER BY price ASC", [PRODUCT_STATUS.ACTIVE]);
    }
    return query('SELECT * FROM commerce_products ORDER BY price ASC');
}

/**
 * "Remove" um produto do catálogo sem apagar a linha — pedidos antigos
 * (via product_snapshot, nunca via este product_id ao vivo) continuam
 * intactos. Um produto arquivado nunca aparece em getAllProducts(true)
 * nem pode ser usado em confirmProduct() de um pedido novo.
 */
function archiveProduct(productId) {
    const product = getProduct(productId);
    if (!product) throw new Error(`Produto não encontrado: ${productId}`);
    run("UPDATE commerce_products SET status = ?, updated_at = datetime('now') WHERE id = ?", [PRODUCT_STATUS.ARCHIVED, productId]);
    recordAuditEvent({
        userId: null,
        event: 'commerce:product_archived',
        details: JSON.stringify({ productId }),
        severity: 'info',
    });
    return getProduct(productId);
}

/**
 * Monta o snapshot imutável gravado em orders.product_snapshot no
 * momento da confirmação do pedido. Contém TODOS os campos comercialmente
 * relevantes (não só o preço) — uma vez gravado no pedido, nunca mais é
 * relido daqui (ver OrderManager.confirmProduct()).
 *
 * Lança se o produto não existir ou não estiver 'active' — nunca monta
 * um snapshot a partir de um produto arquivado (evita vender algo que o
 * catálogo já não oferece mais).
 */
function buildProductSnapshot(productId) {
    const product = getProduct(productId);
    if (!product) throw new Error(`Produto não encontrado: ${productId}`);
    if (product.status !== PRODUCT_STATUS.ACTIVE) {
        throw new Error(`Produto "${productId}" não está disponível para compra (status: ${product.status}).`);
    }

    return {
        id: product.id,
        guildId: product.guild_id,
        name: product.name,
        description: product.description,
        price: product.price,
        maxBots: product.max_bots,
        maxRam: product.max_ram,
        maxCpu: product.max_cpu,
        storage: product.storage,
        billingPeriod: product.billing_period,
        roleToAdd: product.role_to_add,
        roleToRemove: product.role_to_remove,
        snapshotAt: new Date().toISOString(),
    };
}

module.exports = {
    PRODUCT_STATUS,
    VALID_BILLING_PERIODS,
    saveProduct,
    getProduct,
    getAllProducts,
    archiveProduct,
    buildProductSnapshot,
};
