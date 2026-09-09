/**
 * PRODUCT CATALOG (Sistema Comercial — Fase 2/3)
 *
 * CRUD do catálogo de produtos (planos mensais de capacidade de
 * hospedagem, v1) e o construtor do snapshot imutável usado por
 * OrderManager.confirmProduct(). Ver COMMERCIAL_ARCHITECTURE_PROPOSAL.md
 * §2/§6.
 *
 * Ciclo de vida do produto (Fase 3 — pedido explícito: criar/editar/
 * publicar/pausar/arquivar):
 *
 *   DRAFT ──publish──► PUBLISHED ──pause──► PAUSED
 *     │                    │                    │
 *     └──────archive───────┴────────archive──────┘
 *                           ▼
 *                       ARCHIVED (terminal)
 *
 * Só produtos PUBLISHED aparecem pro cliente (getPublishedProducts()) e
 * só produtos PUBLISHED podem ter um snapshot montado pra um pedido novo
 * (buildProductSnapshot()) — DRAFT/PAUSED/ARCHIVED nunca são compráveis,
 * cada um por um motivo diferente (ainda não pronto / temporariamente
 * indisponível / removido definitivamente), mas o efeito de "não pode
 * comprar agora" é o mesmo pros três.
 *
 * Nunca decide preço nem calcula desconto — isso é OrderManager +
 * CouponManager. Este módulo só sabe "o que é o produto agora".
 */
const { get, run, query } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');
const capacityManager = require('../capacityManager');

const PRODUCT_STATUS = Object.freeze({
    DRAFT: 'draft',
    PUBLISHED: 'published',
    PAUSED: 'paused',
    ARCHIVED: 'archived',
});

// Única fonte de verdade da máquina de estados do produto — mesmo
// princípio de OrderManager.VALID_TRANSITIONS.
const VALID_PRODUCT_TRANSITIONS = Object.freeze({
    [PRODUCT_STATUS.DRAFT]: [PRODUCT_STATUS.PUBLISHED, PRODUCT_STATUS.ARCHIVED],
    [PRODUCT_STATUS.PUBLISHED]: [PRODUCT_STATUS.PAUSED, PRODUCT_STATUS.ARCHIVED],
    [PRODUCT_STATUS.PAUSED]: [PRODUCT_STATUS.PUBLISHED, PRODUCT_STATUS.ARCHIVED],
    [PRODUCT_STATUS.ARCHIVED]: [],
});

const VALID_BILLING_PERIODS = new Set(['monthly']); // v1: só mensal (decisão #3)

/**
 * FASE 9 (hardening): um produto com specs acima do teto real do host
 * nunca é vendável — `capacityManager.applyHostCaps()` clampa a escrita
 * de capacidade silenciosamente, e a verificação pós-grant() do
 * ProvisioningManager (Fase 7, não alterada) compara contra o snapshot
 * BRUTO do produto — então toda venda desse produto falharia sempre, já
 * depois do pagamento confirmado. Nunca duplica a leitura de
 * `HOST_MAX_*` aqui — reusa `applyHostCaps()` como fonte única de
 * verdade dos limites (o mesmo que decide o clamp real).
 */
function assertWithinHostCaps({ maxBots, maxRam, maxCpu }) {
    const capped = capacityManager.applyHostCaps({ maxBots, maxRam, maxCpu });
    const problems = [];
    if (capped.maxBots !== Number(maxBots)) problems.push(`bots (${maxBots} > teto do host ${capped.maxBots})`);
    if (capped.maxRam !== Number(maxRam)) problems.push(`RAM (${maxRam}MB > teto do host ${capped.maxRam}MB)`);
    if (capped.maxCpu !== Number(maxCpu)) problems.push(`CPU (${maxCpu}% > teto do host ${capped.maxCpu}%)`);
    if (problems.length) {
        throw new Error(
            `Produto estruturalmente invendível — specs acima do teto do host: ${problems.join(', ')}. ` +
            `Reduza os valores ou peça pro administrador aumentar HOST_MAX_RAM_PER_BOT/HOST_MAX_CPU_PER_BOT/HOST_MAX_BOTS_PER_USER.`
        );
    }
}

/**
 * Cria ou atualiza um produto. Nunca apaga — arquivar (archiveProduct) é
 * o único jeito de "remover" um produto do catálogo, porque pedidos
 * antigos continuam referenciando product_id pra fins de exibição
 * administrativa (o snapshot em si nunca depende disso continuar
 * existindo).
 *
 * Um produto NOVO sempre nasce DRAFT — nunca visível ao cliente até uma
 * chamada explícita a publishProduct(). Editar um produto já existente
 * (mesmo `id`) preserva o status atual (editar não republica nem
 * despublica sozinho).
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
    // FASE 10 (correção de bug real, defesa em profundidade — mesmo
    // princípio já usado pra `price` acima e pro teto do host na Fase 9):
    // nunca aceita capacidade negativa, não importa quem chama
    // saveProduct() — a validação do modal (commerce.js) é só a primeira
    // camada, esta é a que garante que NENHUM caminho (UI, script, teste)
    // consegue persistir um produto com specs negativas.
    if (![maxBots, maxRam, maxCpu].every((v) => Number.isFinite(v) && v >= 0)) {
        throw new Error('ProductCatalog.saveProduct requer maxBots/maxRam/maxCpu numéricos válidos e nunca negativos.');
    }
    assertWithinHostCaps({ maxBots, maxRam, maxCpu });

    const existing = getProduct(id);
    const isNew = !existing;
    // Editar preserva o status atual — nunca republica/despublica como
    // efeito colateral de uma edição de preço/descrição.
    const status = existing ? existing.status : PRODUCT_STATUS.DRAFT;

    run(`
        INSERT INTO commerce_products (id, guild_id, name, description, price, max_bots, max_ram, max_cpu, storage, billing_period, role_to_add, role_to_remove, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            guild_id=excluded.guild_id, name=excluded.name, description=excluded.description,
            price=excluded.price, max_bots=excluded.max_bots, max_ram=excluded.max_ram,
            max_cpu=excluded.max_cpu, storage=excluded.storage, billing_period=excluded.billing_period,
            role_to_add=excluded.role_to_add, role_to_remove=excluded.role_to_remove,
            updated_at=datetime('now')
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

/** Todos os produtos (qualquer status) — uso administrativo. */
function getAllProducts() {
    return query('SELECT * FROM commerce_products ORDER BY price ASC');
}

/** SÓ produtos PUBLISHED — o único conjunto que a loja pública do cliente pode mostrar. */
function getPublishedProducts() {
    return query('SELECT * FROM commerce_products WHERE status = ? ORDER BY price ASC', [PRODUCT_STATUS.PUBLISHED]);
}

function transitionProductStatus(productId, fromStatuses, toStatus, auditEvent) {
    const product = getProduct(productId);
    if (!product) throw new Error(`Produto não encontrado: ${productId}`);
    if (!fromStatuses.includes(product.status)) {
        throw new Error(`Produto "${productId}" está "${product.status}" — não é possível ${auditEvent.split(':')[1]} a partir daí.`);
    }
    run("UPDATE commerce_products SET status = ?, updated_at = datetime('now') WHERE id = ?", [toStatus, productId]);
    recordAuditEvent({ userId: null, event: auditEvent, details: JSON.stringify({ productId }), severity: 'info' });
    return getProduct(productId);
}

/**
 * Publica o produto — passa a aparecer na loja e a poder ser comprado.
 *
 * FASE 9: revalida contra o teto do host mesmo aqui — defesa em
 * profundidade pra um registro que já existia no banco antes desta
 * validação existir (saveProduct() só valida no momento em que É
 * chamado; um DRAFT/PAUSED antigo com specs inválidas nunca passaria
 * por saveProduct() de novo só por estar sendo publicado agora).
 */
function publishProduct(productId) {
    const product = getProduct(productId);
    if (!product) throw new Error(`Produto não encontrado: ${productId}`);
    assertWithinHostCaps({ maxBots: product.max_bots, maxRam: product.max_ram, maxCpu: product.max_cpu });
    return transitionProductStatus(productId, [PRODUCT_STATUS.DRAFT, PRODUCT_STATUS.PAUSED], PRODUCT_STATUS.PUBLISHED, 'commerce:product_published');
}

/** Pausa o produto — some da loja, mas NUNCA afeta pedidos/entitlements já existentes (que vivem só do snapshot). Pode ser republicado depois. */
function pauseProduct(productId) {
    return transitionProductStatus(productId, [PRODUCT_STATUS.PUBLISHED], PRODUCT_STATUS.PAUSED, 'commerce:product_paused');
}

/**
 * "Remove" um produto do catálogo em definitivo — terminal, nunca
 * republicável. Nunca apaga a linha — pedidos antigos (via
 * product_snapshot, nunca via este product_id ao vivo) continuam
 * intactos.
 */
function archiveProduct(productId) {
    return transitionProductStatus(
        productId,
        [PRODUCT_STATUS.DRAFT, PRODUCT_STATUS.PUBLISHED, PRODUCT_STATUS.PAUSED],
        PRODUCT_STATUS.ARCHIVED,
        'commerce:product_archived'
    );
}

/**
 * Monta o snapshot imutável gravado em orders.product_snapshot no
 * momento da confirmação do pedido. Contém TODOS os campos comercialmente
 * relevantes (não só o preço) — uma vez gravado no pedido, nunca mais é
 * relido daqui (ver OrderManager.confirmProduct()).
 *
 * Lança se o produto não existir ou não estiver PUBLISHED — nunca monta
 * um snapshot a partir de um produto em rascunho, pausado ou arquivado
 * (evita vender algo que a loja não está oferecendo agora, seja qual
 * for o motivo).
 */
function buildProductSnapshot(productId) {
    const product = getProduct(productId);
    if (!product) throw new Error(`Produto não encontrado: ${productId}`);
    if (product.status !== PRODUCT_STATUS.PUBLISHED) {
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
    VALID_PRODUCT_TRANSITIONS,
    VALID_BILLING_PERIODS,
    saveProduct,
    getProduct,
    getAllProducts,
    getPublishedProducts,
    publishProduct,
    pauseProduct,
    archiveProduct,
    buildProductSnapshot,
};
