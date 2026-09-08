/**
 * COMMERCE SCHEDULER (Sistema Comercial — Fase 2)
 *
 * Varreduras periódicas pros estados que precisam de "passagem de tempo"
 * pra transicionar, sem nenhuma ação humana:
 *
 *  - sweepExpiredCarts(): AWAITING_PAYMENT sem comprovante depois de N
 *    horas (default 2h, configurável — decisão de negócio confirmada) →
 *    EXPIRED. Nunca cobra, nunca provisiona nada.
 *  - sweepExpiredEntitlements(): entitlements 'active' cujo expires_at
 *    já passou → 'expired', recomputa capacidade do usuário.
 *  - reconcileStuckProvisioning(): pedidos presos em PROVISIONING (o
 *    processo caiu no meio) → PROVISIONING_FAILED. Mesmo princípio do
 *    `IncidentResponseManager.reconcileStuckIncidents()` do Kamikaze:
 *    nunca tenta resumir um provisionamento parcial às cegas. Ainda sem
 *    ProvisioningManager real nesta fase — esta função já fica pronta
 *    (e testada) pro dia em que ele existir.
 *
 * Não é chamado automaticamente por index.js nesta fase (o painel/fluxo
 * público de compra, que é quem geraria pedidos de verdade em produção,
 * também não está implementado ainda) — start/stop existem pra quando a
 * fase que liga a interface do Discord também ligar o timer.
 */
const { query } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');
const config = require('../../../config');
const OrderManager = require('./OrderManager');
const EntitlementManager = require('./EntitlementManager');

let sweepTimer = null;

/** AWAITING_PAYMENT parado há mais de `cartExpirationHours` → EXPIRED. */
function sweepExpiredCarts() {
    const hours = config.commerce.cartExpirationHours;
    const candidates = query(
        `SELECT * FROM commerce_orders WHERE status = ? AND updated_at <= datetime('now', ?)`,
        [OrderManager.STATUS.AWAITING_PAYMENT, `-${hours} hours`]
    );

    let expiredCount = 0;
    for (const order of candidates) {
        const result = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.AWAITING_PAYMENT], OrderManager.STATUS.EXPIRED);
        if (result) expiredCount += 1;
    }
    if (expiredCount) {
        recordAuditEvent({
            userId: null,
            event: 'commerce:scheduler_carts_expired',
            details: JSON.stringify({ count: expiredCount, thresholdHours: hours }),
            severity: 'info',
        });
    }
    return expiredCount;
}

/** Entitlements 'active' com expires_at já no passado → 'expired'. */
function sweepExpiredEntitlements() {
    const candidates = query(
        `SELECT * FROM commerce_entitlements WHERE status = ? AND expires_at <= datetime('now')`,
        [EntitlementManager.ENTITLEMENT_STATUS.ACTIVE]
    );

    let count = 0;
    for (const entitlement of candidates) {
        EntitlementManager.expireEntitlement(entitlement.id);
        count += 1;
    }
    if (count) {
        recordAuditEvent({
            userId: null,
            event: 'commerce:scheduler_entitlements_expired',
            details: JSON.stringify({ count }),
            severity: 'info',
        });
    }
    return count;
}

/**
 * Reconciliação pós-restart: qualquer pedido preso em PROVISIONING no
 * momento em que o processo caiu vira PROVISIONING_FAILED — nunca
 * resume às cegas. Mesmo espírito de `reconcileStuckIncidents()`.
 */
function reconcileStuckProvisioning() {
    const stuck = query('SELECT * FROM commerce_orders WHERE status = ?', [OrderManager.STATUS.PROVISIONING]);

    let count = 0;
    for (const order of stuck) {
        const result = OrderManager.transitionOrder(order.id, [OrderManager.STATUS.PROVISIONING], OrderManager.STATUS.PROVISIONING_FAILED);
        if (result) count += 1;
    }
    if (count) {
        recordAuditEvent({
            userId: null,
            event: 'commerce:scheduler_provisioning_reconciled',
            details: JSON.stringify({ count }),
            severity: 'warning',
        });
        console.warn(`[CommerceScheduler] ${count} pedido(s) preso(s) em PROVISIONING de uma execução anterior marcados como PROVISIONING_FAILED.`);
    }
    return count;
}

function runAllSweeps() {
    sweepExpiredCarts();
    sweepExpiredEntitlements();
}

function startCommerceScheduler(intervalMs = 15 * 60 * 1000) {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
        try {
            runAllSweeps();
        } catch (err) {
            console.error('[CommerceScheduler] Falha numa varredura periódica:', err.message);
        }
    }, intervalMs);
    if (sweepTimer.unref) sweepTimer.unref();
}

function stopCommerceScheduler() {
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
}

module.exports = {
    sweepExpiredCarts,
    sweepExpiredEntitlements,
    reconcileStuckProvisioning,
    runAllSweeps,
    startCommerceScheduler,
    stopCommerceScheduler,
};
