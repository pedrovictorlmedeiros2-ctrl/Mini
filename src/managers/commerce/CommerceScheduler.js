/**
 * COMMERCE SCHEDULER (Sistema Comercial — Fase 2)
 *
 * Varreduras periódicas pros estados que precisam de "passagem de tempo"
 * pra transicionar, sem nenhuma ação humana:
 *
 *  - sweepExpiredCarts(): AWAITING_PAYMENT sem comprovante depois de N
 *    horas (default 2h, configurável — decisão de negócio confirmada) →
 *    EXPIRED. Nunca cobra, nunca provisiona nada.
 *  - sweepExpiringEntitlements() (Fase 8): entitlements 'active' expirando
 *    dentro de `config.commerce.renewalReminderDays` dias, ainda não
 *    avisados neste ciclo → DM best-effort orientando a renovar, marca
 *    `renewal_reminder_sent_at` (nunca reenvia no mesmo ciclo).
 *  - sweepExpiredEntitlements(): entitlements 'active' cujo expires_at
 *    já passou → 'expired', recomputa capacidade do usuário, DM
 *    best-effort avisando que expirou (Fase 8).
 *  - reconcileStuckProvisioning(): pedidos presos em PROVISIONING (o
 *    processo caiu no meio) → PROVISIONING_FAILED. Mesmo princípio do
 *    `IncidentResponseManager.reconcileStuckIncidents()` do Kamikaze:
 *    nunca tenta resumir um provisionamento parcial às cegas. Chamado só
 *    uma vez, no boot (ver index.js) — nunca nesta varredura periódica
 *    (rodar enquanto o ProvisioningManager está genuinamente no meio de
 *    um provisionamento derrubaria uma tentativa legítima).
 *
 * `startCommerceScheduler()` é chamado uma vez no boot (index.js, Fase 8)
 * — antes disso (Fases 2-7), a função existia e era testada isoladamente,
 * mas nunca era ligada em produção; nenhuma destas sweeps rodava de fato
 * fora de teste.
 */
const { query } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');
const config = require('../../../config');
const OrderManager = require('./OrderManager');
const EntitlementManager = require('./EntitlementManager');
const ProofManager = require('./ProofManager');
const { tryDM } = require('../../utils/clientRef');

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

/**
 * Entitlements 'active' com expires_at já no passado → 'expired'.
 *
 * Fase 8: também dispara uma DM best-effort avisando o cliente que o
 * plano expirou, com orientação pra renovar. `tryDM()` (src/utils/clientRef.js)
 * nunca lança — nem quando o client do Discord ainda não está pronto, nem
 * quando a DM falha (fechada, usuário saiu de todos os servidores em
 * comum) — então é chamada sem `await` de propósito: a falha de
 * notificação NUNCA pode atrasar nem quebrar a sweep em si (mesmo
 * princípio fail-safe já usado em `notifyBuyer()` de commerce.js).
 */
function sweepExpiredEntitlements() {
    const candidates = query(
        `SELECT * FROM commerce_entitlements WHERE status = ? AND expires_at <= datetime('now')`,
        [EntitlementManager.ENTITLEMENT_STATUS.ACTIVE]
    );

    let count = 0;
    for (const entitlement of candidates) {
        EntitlementManager.expireEntitlement(entitlement.id);
        count += 1;
        tryDM(
            entitlement.user_id,
            '⏰ **Seu plano expirou.** Sua capacidade de hospedagem foi reduzida. ' +
            'Use o botão **Renovar Plano** na loja pra reativar sem interrupção.'
        );
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
 * Fase 8: entitlements 'active' expirando dentro de
 * `config.commerce.renewalReminderDays` dias, ainda não avisados neste
 * ciclo — avisa e marca (`EntitlementManager.markRenewalReminderSent()`,
 * único lugar que escreve essa coluna, nunca um UPDATE direto aqui).
 * Nunca reenvia no mesmo ciclo; uma renovação cria um entitlement novo
 * (`renewal_reminder_sent_at` nasce NULL de novo), então o próximo ciclo
 * sempre pode gerar um aviso novo, sem lógica extra de reset.
 */
function sweepExpiringEntitlements() {
    const days = config.commerce.renewalReminderDays;
    const candidates = query(
        `SELECT * FROM commerce_entitlements
         WHERE status = ? AND renewal_reminder_sent_at IS NULL
           AND expires_at <= datetime('now', ?) AND expires_at > datetime('now')`,
        [EntitlementManager.ENTITLEMENT_STATUS.ACTIVE, `+${days} days`]
    );

    let count = 0;
    for (const entitlement of candidates) {
        EntitlementManager.markRenewalReminderSent(entitlement.id);
        count += 1;
        tryDM(
            entitlement.user_id,
            `⚠️ **Seu plano expira em breve** (${entitlement.expires_at}). ` +
            'Use o botão **Renovar Plano** na loja pra continuar sem perder capacidade.'
        );
    }
    if (count) {
        recordAuditEvent({
            userId: null,
            event: 'commerce:scheduler_expiration_reminders_sent',
            details: JSON.stringify({ count, windowDays: days }),
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

/**
 * Retenção de comprovantes (Fase 5) — wrapper fino sobre
 * `ProofManager.purgeExpiredProofs()`, chamado periodicamente como as
 * outras varreduras. A lógica de segurança (nunca purgar um comprovante
 * ainda pendente de revisão, nunca apagar a linha do banco) vive inteira
 * dentro do ProofManager — este módulo só decide QUANDO rodar.
 */
function sweepExpiredProofs() {
    return ProofManager.purgeExpiredProofs();
}

function runAllSweeps() {
    sweepExpiredCarts();
    sweepExpiringEntitlements();
    sweepExpiredEntitlements();
    sweepExpiredProofs();
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
    sweepExpiringEntitlements,
    sweepExpiredEntitlements,
    sweepExpiredProofs,
    reconcileStuckProvisioning,
    runAllSweeps,
    startCommerceScheduler,
    stopCommerceScheduler,
};
