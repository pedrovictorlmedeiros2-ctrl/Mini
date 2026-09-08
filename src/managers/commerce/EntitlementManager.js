/**
 * ENTITLEMENT MANAGER (Sistema Comercial — Fase 2)
 *
 * Entitlement = a capacidade de hospedagem EFETIVAMENTE concedida ao
 * cliente (decisão de negócio confirmada). Só `grant()` pode levar um
 * pedido a ter um Entitlement ativo — nunca é chamado antes do
 * provisionamento estar confirmado (na prática, hoje, chamado só depois
 * de `order.status === 'PROVISIONING'`; o futuro ProvisioningManager é
 * quem decide QUANDO chamar isto, este módulo só garante que o pedido
 * está no estado certo pra receber a chamada).
 *
 * DUAS decisões de negócio finais (confirmadas nesta fase) implementadas
 * aqui:
 *
 * 1) Renovação antecipada: `activated_at = max(agora, expires_at do
 *    entitlement anterior)`. Renovação depois de já expirado começa
 *    imediatamente (o `max()` cobre os dois casos com a mesma fórmula).
 *
 * 2) V1: um cliente NUNCA acumula múltiplos entitlements de hospedagem
 *    simultaneamente. Implementado como uma invariante estrutural — não
 *    uma convenção: `grant()` sempre fecha (`status='expired'`) o
 *    entitlement anterior no MESMO instante em que cria o novo, quando é
 *    uma renovação; e RECUSA (lança) criar um novo entitlement pra um
 *    pedido que não é renovação se o usuário já tiver um ativo. Nunca
 *    existe mais de uma linha com status='active' por usuário — nem
 *    por uma fração de segundo, porque a troca acontece dentro do mesmo
 *    trecho síncrono (sem `await` entre o UPDATE do antigo e o INSERT do
 *    novo — mesmo princípio de ausência de corrida já usado em
 *    OrderManager.transitionOrder()).
 *
 *    Nota deliberada: numa renovação antecipada, o entitlement anterior
 *    é marcado 'expired' no momento da renovação, mesmo que seu
 *    expires_at real ainda esteja no futuro. Isso é uma simplificação
 *    consciente (o status passa a significar "não é mais o entitlement
 *    corrente", não literalmente "o tempo dele já passou") — nenhuma
 *    capacidade é perdida: o novo entitlement começa exatamente onde o
 *    antigo seria consumido (`activated_at` = expiração do antigo).
 */
const { get, run, query } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');
const OrderManager = require('./OrderManager');

const ENTITLEMENT_STATUS = Object.freeze({
    PENDING_PROVISIONING: 'pending_provisioning',
    ACTIVE: 'active',
    EXPIRED: 'expired',
    REVOKED: 'revoked',
});

/** Formata um Date pro mesmo formato de string que `datetime('now')` do SQLite produz (UTC, sem milissegundos, espaço em vez de 'T'). */
function toSqliteDatetime(date) {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Lê de volta uma string DATETIME do SQLite como um Date em UTC (nunca deixa o motor JS interpretar como horário local). */
function fromSqliteDatetime(str) {
    if (!str) return null;
    return new Date(str.replace(' ', 'T') + 'Z');
}

/** Soma um mês em aritmética de calendário (billing_period='monthly', único período da v1). */
function addOneMonth(date) {
    const d = new Date(date.getTime());
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d;
}

class EntitlementConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'EntitlementConflictError';
    }
}

function getEntitlement(entitlementId) {
    return get('SELECT * FROM commerce_entitlements WHERE id = ?', [entitlementId]);
}

function getEntitlementByOrder(orderId) {
    return get('SELECT * FROM commerce_entitlements WHERE order_id = ?', [orderId]);
}

/** No máximo UM por usuário, por construção (garantido por grant() — nunca por convenção). */
function getActiveEntitlement(userId) {
    const rows = query("SELECT * FROM commerce_entitlements WHERE user_id = ? AND status = ?", [userId, ENTITLEMENT_STATUS.ACTIVE]);
    if (rows.length > 1) {
        // Nunca deveria acontecer — grant() garante no máximo 1. Se acontecer,
        // é uma violação de integridade que precisa ser investigada, não
        // silenciosamente tolerada (ex.: escrita direta no banco por fora
        // deste módulo).
        throw new Error(`Violação de integridade: usuário ${userId} tem ${rows.length} entitlements 'active' simultâneos (esperado: no máximo 1).`);
    }
    return rows[0] || null;
}

/**
 * Concede o Entitlement de um pedido. Idempotente: se já existe um
 * entitlement 'active' pra este orderId, retorna ele sem reprocessar
 * (mesmo princípio de idempotência do ProvisioningManager, arquitetura
 * §8 — este é o passo final que ele vai chamar).
 */
function grant(orderId) {
    const order = OrderManager.getOrder(orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    if (order.status !== OrderManager.STATUS.PROVISIONING) {
        throw new Error(`Pedido #${orderId} não está em PROVISIONING (status atual: ${order.status}) — grant() só pode ser chamado nesse estado.`);
    }

    const existingForOrder = getEntitlementByOrder(orderId);
    if (existingForOrder && existingForOrder.status === ENTITLEMENT_STATUS.ACTIVE) {
        return existingForOrder; // já concedido — no-op idempotente
    }

    const now = new Date();
    let activatedAt;

    if (order.renewal_of_entitlement_id) {
        const referenced = getEntitlement(order.renewal_of_entitlement_id);
        if (!referenced || referenced.user_id !== order.user_id) {
            throw new Error(`Pedido #${orderId}: renewal_of_entitlement_id (${order.renewal_of_entitlement_id}) não pertence ao usuário ${order.user_id}.`);
        }
        if (referenced.status === ENTITLEMENT_STATUS.REVOKED) {
            throw new Error(`Não é possível renovar o entitlement #${referenced.id} — ele foi revogado administrativamente.`);
        }

        const currentActive = getActiveEntitlement(order.user_id);
        if (currentActive && currentActive.id !== referenced.id) {
            throw new EntitlementConflictError(
                `Usuário ${order.user_id} já tem um entitlement ativo (#${currentActive.id}) diferente do que está sendo renovado (#${referenced.id}) — não acumula múltiplos entitlements simultaneamente.`
            );
        }

        // Decisão #1 (renovação antecipada): activated_at = max(agora,
        // expires_at do anterior). Renovação após expiração começa
        // imediatamente — coberto pela mesma fórmula (max com uma data
        // passada resolve pra "agora").
        const referencedExpiresAt = fromSqliteDatetime(referenced.expires_at);
        activatedAt = referencedExpiresAt && referencedExpiresAt > now ? referencedExpiresAt : now;

        // Fecha o entitlement anterior — nunca duas linhas 'active' pro
        // mesmo usuário simultaneamente (decisão #2). Só toca se ainda
        // estiver 'active' (renovar um já expirado não precisa reescrever
        // status, já está correto).
        if (referenced.status === ENTITLEMENT_STATUS.ACTIVE) {
            run("UPDATE commerce_entitlements SET status = ?, updated_at = datetime('now') WHERE id = ?", [ENTITLEMENT_STATUS.EXPIRED, referenced.id]);
        }
    } else {
        const currentActive = getActiveEntitlement(order.user_id);
        if (currentActive) {
            throw new EntitlementConflictError(
                `Usuário ${order.user_id} já tem um entitlement ativo (#${currentActive.id}) — não acumula múltiplos entitlements simultaneamente na v1. Use renewal_of_entitlement_id para renovar o existente.`
            );
        }
        activatedAt = now;
    }

    const expiresAt = addOneMonth(activatedAt);

    run(
        `INSERT INTO commerce_entitlements (guild_id, order_id, user_id, status, activated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [order.guild_id, orderId, order.user_id, ENTITLEMENT_STATUS.ACTIVE, toSqliteDatetime(activatedAt), toSqliteDatetime(expiresAt)]
    );

    const entitlement = getEntitlementByOrder(orderId);
    recomputeUserCapacity(order.user_id);

    recordAuditEvent({
        userId: null,
        event: 'commerce:entitlement_granted',
        details: JSON.stringify({
            orderId, entitlementId: entitlement.id, userId: order.user_id,
            renewalOf: order.renewal_of_entitlement_id || null,
            activatedAt: entitlement.activated_at, expiresAt: entitlement.expires_at,
        }),
        severity: 'info',
    });
    return entitlement;
}

/**
 * Recalcula a capacidade efetiva do usuário. Delegado inteiramente a
 * `capacityManager.js` (fonte única de verdade — ver o comentário
 * normativo naquele arquivo sobre a precedência entre Entitlement e o
 * `plan_id` do sistema legado). Este módulo nunca escreve em
 * `users.max_bots/max_ram/max_cpu` diretamente — só aciona o
 * recálculo depois de qualquer mudança no próprio Entitlement.
 *
 * Lazy require: `capacityManager.js` também precisa ler
 * `getActiveEntitlement` deste módulo — top-level nos dois lados criaria
 * um ciclo. Mesmo padrão já usado no projeto (SecurityEngine ↔
 * IncidentResponseManager).
 */
function recomputeUserCapacity(userId) {
    const capacityManager = require('../capacityManager');
    return capacityManager.recomputeUserCapacity(userId);
}

/** Expira um entitlement (chamado pelo CommerceScheduler quando expires_at já passou). */
function expireEntitlement(entitlementId) {
    const entitlement = getEntitlement(entitlementId);
    if (!entitlement) throw new Error(`Entitlement não encontrado: ${entitlementId}`);
    if (entitlement.status !== ENTITLEMENT_STATUS.ACTIVE) {
        return entitlement; // já não está ativo — no-op idempotente
    }

    run("UPDATE commerce_entitlements SET status = ?, updated_at = datetime('now') WHERE id = ?", [ENTITLEMENT_STATUS.EXPIRED, entitlementId]);
    recomputeUserCapacity(entitlement.user_id);

    recordAuditEvent({
        userId: null,
        event: 'commerce:entitlement_expired',
        details: JSON.stringify({ entitlementId, userId: entitlement.user_id }),
        severity: 'info',
    });
    return getEntitlement(entitlementId);
}

/** Revogação administrativa (ex.: chargeback, fraude) — nunca automática nesta fase. */
function revokeEntitlement(entitlementId, revokedByUserId, reason) {
    const entitlement = getEntitlement(entitlementId);
    if (!entitlement) throw new Error(`Entitlement não encontrado: ${entitlementId}`);
    if (entitlement.status === ENTITLEMENT_STATUS.REVOKED) {
        return entitlement; // já revogado — no-op idempotente
    }

    run("UPDATE commerce_entitlements SET status = ?, updated_at = datetime('now') WHERE id = ?", [ENTITLEMENT_STATUS.REVOKED, entitlementId]);
    recomputeUserCapacity(entitlement.user_id);

    recordAuditEvent({
        userId: revokedByUserId,
        event: 'commerce:entitlement_revoked',
        details: JSON.stringify({ entitlementId, userId: entitlement.user_id, reason: reason || null }),
        severity: 'warning',
    });
    return getEntitlement(entitlementId);
}

module.exports = {
    ENTITLEMENT_STATUS,
    EntitlementConflictError,
    getEntitlement,
    getEntitlementByOrder,
    getActiveEntitlement,
    grant,
    recomputeUserCapacity,
    expireEntitlement,
    revokeEntitlement,
    _toSqliteDatetime: toSqliteDatetime,
    _fromSqliteDatetime: fromSqliteDatetime,
    _addOneMonth: addOneMonth,
};
