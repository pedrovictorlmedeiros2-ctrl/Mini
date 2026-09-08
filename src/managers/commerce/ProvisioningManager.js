/**
 * PROVISIONING MANAGER (Sistema Comercial — Fase 7)
 *
 * Única autoridade comercial para provisionamento (regra absoluta #1 da
 * Fase 7 — ver COMMERCIAL_PHASE7_PROVISIONING_PLAN.md). Conecta
 * Payment confirmado → Entitlement → capacidade de hospedagem, de forma
 * idempotente e fail-closed.
 *
 * NUNCA:
 * - importa child_process, SandboxManager, processManager, ou qualquer
 *   coisa de src/managers/security/;
 * - cria processo, inicia bot, ou toca em bots.suspended;
 * - escreve em users.max_bots/max_ram/max_cpu diretamente (isso é
 *   exclusivo de capacityManager.js, acionado indiretamente via
 *   EntitlementManager.grant());
 * - contorna serviceReadiness.assertProvisioningAllowed().
 *
 * V1 é estritamente a estratégia "entitlement_only": conceder capacidade
 * NUNCA cria um bot. Reativar um bot suspenso pelo Kamikaze exigiria
 * chamar processManager.startBot() — algo que este módulo nunca faz —
 * então a precedência do Kamikaze sobre provisionamento comercial é
 * garantida pela AUSÊNCIA estrutural desse caminho, não por uma checagem
 * duplicada de segurança dentro do código comercial.
 *
 * GARANTIA DE EXCLUSIVIDADE MÚTUA: o CAS de
 * `OrderManager.transitionOrder(orderId, [APPROVED, PROVISIONING_FAILED],
 * PROVISIONING)` é a ÚNICA seção crítica real — persistente (banco),
 * nunca um lock em memória. Tudo que roda depois dele (steps 6-10 do
 * fluxo) só executa pra quem venceu esse CAS. A idempotência de
 * `EntitlementManager.grant()` (não duplica se já existe um entitlement
 * ativo pro pedido) é a segunda camada, cobrindo o caso em que o
 * processo morre entre o CAS e a conclusão — um retry seguinte
 * (depois da reconciliação de boot) reentra pelo mesmo CAS e o grant()
 * idempotente evita duplicar a concessão.
 */
const { get, run, query } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');
const OrderManager = require('./OrderManager');
const PaymentManager = require('./PaymentManager');
const EntitlementManager = require('./EntitlementManager');
const CommerceStaffManager = require('./CommerceStaffManager');
const serviceReadiness = require('../serviceReadiness');

const ATTEMPT_STATUS = Object.freeze({ RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed' });

/**
 * Sanitiza uma mensagem de erro antes de persistir (nunca secrets, nunca
 * stack trace). Autocontida — nunca importa nada de src/managers/security/
 * pra manter a árvore de dependências limpa (mesmo princípio já
 * estabelecido desde a Fase 1: comercial nunca depende de segurança).
 */
function sanitizeErrorMessage(err) {
    const raw = String(err && err.message ? err.message : err || 'erro desconhecido');
    const truncated = raw.slice(0, 500);
    // Remove qualquer coisa que pareça um valor de variável de ambiente,
    // token ou chave (padrão simples: sequências longas alfanuméricas com
    // símbolos típicos de segredo, ou trechos explicitamente rotulados).
    return truncated
        .replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]')
        .replace(/(token|password|senha|secret|chave|key)\s*[:=]\s*\S+/gi, '$1: [redacted]');
}

function insertAttempt({ orderId, executorUserId }) {
    const idempotencyKey = `${orderId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    run(
        `INSERT INTO commerce_provisioning_attempts (order_id, idempotency_key, status, executor_user_id)
         VALUES (?, ?, ?, ?)`,
        [orderId, idempotencyKey, ATTEMPT_STATUS.RUNNING, executorUserId]
    );
    return get('SELECT * FROM commerce_provisioning_attempts WHERE idempotency_key = ?', [idempotencyKey]);
}

function markAttemptSucceeded(attemptId, entitlementId) {
    run(
        "UPDATE commerce_provisioning_attempts SET status = ?, entitlement_id = ?, finished_at = datetime('now') WHERE id = ?",
        [ATTEMPT_STATUS.SUCCEEDED, entitlementId, attemptId]
    );
}

function markAttemptFailed(attemptId, err) {
    run(
        "UPDATE commerce_provisioning_attempts SET status = ?, error_message = ?, finished_at = datetime('now') WHERE id = ?",
        [ATTEMPT_STATUS.FAILED, sanitizeErrorMessage(err), attemptId]
    );
}

/**
 * Provisiona (concede capacidade para) um pedido aprovado.
 *
 * @param {number} orderId
 * @param {{ executorUserId?: string|null }} [options] - `executorUserId`
 *   nulo = chamada automática pós-aprovação (nunca depende de permissão
 *   Discord do cliente — o gatilho já foi a aprovação do staff, checada
 *   por PaymentManager.confirmPayment()). Preenchido = retry manual,
 *   exige permissão comercial (Administrator ou COMMERCE_STAFF ativo).
 * @returns {{ order: object, entitlement: object, alreadyActive?: true }}
 */
function provision(orderId, { executorUserId = null } = {}) {
    if (executorUserId && !CommerceStaffManager.hasCommercePermission(executorUserId)) {
        throw new Error('Usuário sem permissão comercial (admin ou COMMERCE_STAFF) para retry de provisionamento.');
    }

    // ── PASSO 1: Order válido + idempotência (sempre primeiro) ──────────
    const order = OrderManager.getOrder(orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);

    if (order.status === OrderManager.STATUS.ACTIVE) {
        // Idempotente: nunca reprocessa um pedido já ativo. Não cria uma
        // nova linha de tentativa — não há nada a tentar de novo.
        const entitlement = EntitlementManager.getEntitlementByOrder(orderId);
        return { order, entitlement, alreadyActive: true };
    }
    if (![OrderManager.STATUS.APPROVED, OrderManager.STATUS.PROVISIONING_FAILED].includes(order.status)) {
        throw new Error(`Pedido #${orderId} não está pronto para provisionamento (status atual: ${order.status}).`);
    }

    // ── PASSO 2: Payment confirmado (defesa em profundidade — não deveria
    // ser alcançável de outra forma, já que Order só chega em
    // APPROVED/PROVISIONING_FAILED com o Payment já confirmado) ─────────
    const payment = PaymentManager.getPaymentByOrder(orderId);
    if (!payment || payment.status !== PaymentManager.PAYMENT_STATUS.CONFIRMED) {
        throw new Error(`Pedido #${orderId}: pagamento não está confirmado — não é possível provisionar.`);
    }

    // ── GATE DE EXCLUSIVIDADE (CAS, garantia persistente — regra #6) ────
    const inProgress = OrderManager.transitionOrder(
        orderId,
        [OrderManager.STATUS.APPROVED, OrderManager.STATUS.PROVISIONING_FAILED],
        OrderManager.STATUS.PROVISIONING
    );
    if (!inProgress) {
        throw new Error(`Pedido #${orderId}: outro processo já está provisionando este pedido, ou o estado mudou — tente novamente.`);
    }

    const attempt = insertAttempt({ orderId, executorUserId });

    try {
        // ── PASSO 3: gate de segurança (readiness) ───────────────────────
        // Fail-closed em BLOCKED — nunca cai pra um caminho alternativo.
        serviceReadiness.assertProvisioningAllowed(`provisionamento comercial: pedido #${orderId}`);

        // DEGRADED nunca bloqueia a v1 (entitlement_only não toca em
        // webhook/Docker/Groq — os três únicos motivos de DEGRADED hoje),
        // mas o contexto é sempre registrado, nunca um sucesso silencioso.
        const readiness = serviceReadiness.getReadinessState();
        if (readiness.status === serviceReadiness.STATUS.DEGRADED) {
            recordAuditEvent({
                userId: executorUserId,
                event: 'commerce:provisioning_degraded_context',
                details: JSON.stringify({ orderId, degradedReasons: readiness.degradedReasons }),
                severity: 'info',
            });
        }

        // ── PASSO 4: conceder capacidade (idempotente, via EntitlementManager
        // → capacityManager — este módulo NUNCA escreve em users.* direto) ──
        const entitlement = EntitlementManager.grant(orderId);

        // ── PASSO 5: verificação REAL (nunca confia em retorno booleano) ──
        const freshEntitlement = EntitlementManager.getEntitlement(entitlement.id);
        if (!freshEntitlement || freshEntitlement.status !== EntitlementManager.ENTITLEMENT_STATUS.ACTIVE || freshEntitlement.order_id !== orderId) {
            throw new Error(`Verificação pós-concessão falhou: entitlement #${entitlement.id} não está ativo/consistente com o pedido #${orderId}.`);
        }
        const activeForUser = EntitlementManager.getActiveEntitlement(order.user_id);
        if (!activeForUser || activeForUser.id !== freshEntitlement.id) {
            throw new Error(`Verificação pós-concessão falhou: entitlement ativo do usuário ${order.user_id} não confere com o esperado (duplicação ou inconsistência).`);
        }
        const snapshot = order.product_snapshot ? JSON.parse(order.product_snapshot) : null;
        const freshUser = get('SELECT max_bots, max_ram, max_cpu FROM users WHERE id = ?', [order.user_id]);
        if (snapshot && freshUser && (freshUser.max_bots !== snapshot.maxBots || freshUser.max_ram !== snapshot.maxRam || freshUser.max_cpu !== snapshot.maxCpu)) {
            throw new Error(`Verificação pós-concessão falhou: capacidade efetiva do usuário ${order.user_id} não confere com o snapshot do pedido #${orderId}.`);
        }

        // ── PASSO 6: só agora, ACTIVE (CAS final) ─────────────────────────
        const finalOrder = OrderManager.transitionOrder(orderId, [OrderManager.STATUS.PROVISIONING], OrderManager.STATUS.ACTIVE);
        if (!finalOrder) {
            // Não deveria ser alcançável (nenhum outro código transiciona
            // PROVISIONING pra outro estado enquanto este manager está na
            // seção crítica) — tratado como inconsistência, nunca revertido
            // às cegas (regra #16: nunca um rollback destrutivo improvisado).
            throw new Error(`Inconsistência: pedido #${orderId} saiu de PROVISIONING durante o provisionamento.`);
        }

        markAttemptSucceeded(attempt.id, freshEntitlement.id);
        recordAuditEvent({
            userId: executorUserId,
            event: 'commerce:provisioning_succeeded',
            details: JSON.stringify({ orderId, entitlementId: freshEntitlement.id, attemptId: attempt.id }),
            severity: 'info',
        });

        return { order: finalOrder, entitlement: freshEntitlement };
    } catch (err) {
        // Payment NUNCA é tocado — continua 'confirmed' (regra #8). Nunca
        // cancela o pedido, nunca cria um pedido novo, nunca tenta
        // "corrigir" apagando evidência (regra #16).
        const stillProvisioning = OrderManager.getOrder(orderId)?.status === OrderManager.STATUS.PROVISIONING;
        if (stillProvisioning) {
            OrderManager.transitionOrder(orderId, [OrderManager.STATUS.PROVISIONING], OrderManager.STATUS.PROVISIONING_FAILED);
        }
        markAttemptFailed(attempt.id, err);
        recordAuditEvent({
            userId: executorUserId,
            event: 'commerce:provisioning_failed',
            details: JSON.stringify({ orderId, attemptId: attempt.id, error: sanitizeErrorMessage(err) }),
            severity: 'error',
        });
        throw err;
    }
}

function listProvisioningAttempts(orderId) {
    return query('SELECT * FROM commerce_provisioning_attempts WHERE order_id = ? ORDER BY started_at ASC', [orderId]);
}

module.exports = {
    ATTEMPT_STATUS,
    provision,
    listProvisioningAttempts,
    sanitizeErrorMessage,
};
