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
const config = require('../../../config');

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
 * Fase 8 — elegibilidade pra renovação self-service (`commerce_renew_plan`).
 * Retorna o entitlement ATIVO do usuário se existir; senão, o entitlement
 * 'expired' mais recente, mas SÓ se ainda estiver dentro da janela de
 * tolerância `config.commerce.renewalGraceDays` a partir do `expires_at`
 * real dele. Depois dessa janela, retorna null — o cliente precisa comprar
 * do zero (`commerce_buy_plan`), nunca renovar um plano arbitrariamente
 * antigo. Não concede nada, nem cria nada — só uma leitura de elegibilidade.
 */
function getRenewalEligibleEntitlement(userId) {
    const active = getActiveEntitlement(userId);
    if (active) return active;

    const graceDays = config.commerce.renewalGraceDays;
    const rows = query(
        `SELECT * FROM commerce_entitlements
         WHERE user_id = ? AND status = ? AND expires_at >= datetime('now', ?)
         ORDER BY expires_at DESC LIMIT 1`,
        [userId, ENTITLEMENT_STATUS.EXPIRED, `-${graceDays} days`]
    );
    return rows[0] || null;
}

/**
 * Marca que o aviso de expiração próxima já foi enviado pra este
 * entitlement — nunca reenviado no mesmo ciclo
 * (CommerceScheduler.sweepExpiringEntitlements()). Idempotente (no-op se
 * já estava marcado). Único lugar do sistema que escreve nesta coluna —
 * mesmo princípio de escrita única já usado pro resto desta tabela.
 */
function markRenewalReminderSent(entitlementId) {
    const entitlement = getEntitlement(entitlementId);
    if (!entitlement) throw new Error(`Entitlement não encontrado: ${entitlementId}`);
    if (entitlement.renewal_reminder_sent_at) return entitlement; // já marcado — no-op idempotente

    run("UPDATE commerce_entitlements SET renewal_reminder_sent_at = datetime('now') WHERE id = ?", [entitlementId]);
    return getEntitlement(entitlementId);
}

/**
 * Concede o Entitlement de um pedido. Idempotente: se já existe um
 * entitlement 'active' pra este orderId, retorna ele sem reprocessar
 * (mesmo princípio de idempotência do ProvisioningManager, arquitetura
 * §8 — este é o passo final que ele vai chamar).
 *
 * FASE 9 (correção de C1 — "entitlement fantasma"): antes desta fase, a
 * linha nascia direto com status='active', ANTES de
 * `recomputeUserCapacity()` confirmar que a capacidade foi realmente
 * aplicada — se isso falhasse, sobrava um entitlement 'active' sem
 * capacidade real, e um retry (achando `existingForOrder.status===ACTIVE`)
 * retornava cedo demais, sem tentar de novo.
 *
 * Agora a linha nasce (ou é retomada) como PENDING_PROVISIONING — valor
 * que já era o DEFAULT da coluna desde a Fase 2 (`commerce_entitlements.status
 * DEFAULT 'pending_provisioning'`), nunca antes usado por `grant()`. Só é
 * promovida pra 'active' DEPOIS de `capacityManager.writeUserCapacity()`
 * ter sido chamado com sucesso. Um retry que encontra a linha ainda
 * PENDING_PROVISIONING (em vez de criar uma segunda) a REUTILIZA — tenta
 * aplicar a capacidade de novo, e só promove se conseguir.
 *
 * Nota de implementação: a escrita de capacidade aqui chama
 * `capacityManager.writeUserCapacity()` diretamente (não
 * `capacityManager.recomputeUserCapacity()`) — de propósito.
 * `recomputeUserCapacity()` decide a capacidade lendo
 * `getActiveEntitlement()`, mas nesse ponto do fluxo o entitlement sendo
 * concedido AINDA NÃO está 'active' (é exatamente o que só deve acontecer
 * depois da capacidade confirmada) — chamar `recomputeUserCapacity()"
 * aqui encontraria "nenhum entitlement ativo" e aplicaria a capacidade
 * ERRADA (plano legado ou default). Como já sabemos, neste ponto exato,
 * que ESTE é o entitlement que vai virar o ativo, usamos o snapshot do
 * próprio `order` (já em memória, sem nem precisar reler o banco) e
 * chamamos o primitivo de escrita mais baixo nível de capacityManager.js
 * — que continua sendo, sem nenhuma alteração nesse arquivo, o único
 * lugar que escreve em `users.max_bots/max_ram/max_cpu`.
 */
function grant(orderId) {
    const capacityManager = require('../capacityManager');

    const order = OrderManager.getOrder(orderId);
    if (!order) throw new Error(`Pedido não encontrado: ${orderId}`);
    if (order.status !== OrderManager.STATUS.PROVISIONING) {
        throw new Error(`Pedido #${orderId} não está em PROVISIONING (status atual: ${order.status}) — grant() só pode ser chamado nesse estado.`);
    }

    const existingForOrder = getEntitlementByOrder(orderId);
    if (existingForOrder && existingForOrder.status === ENTITLEMENT_STATUS.ACTIVE) {
        return existingForOrder; // já concedido e confirmado — no-op idempotente
    }

    let entitlement;

    if (existingForOrder && existingForOrder.status === ENTITLEMENT_STATUS.PENDING_PROVISIONING) {
        // RETOMADA: uma tentativa anterior já criou esta linha e já fechou
        // o entitlement antigo (se era renovação), mas morreu ou falhou
        // antes de confirmar a capacidade. Nunca cria uma segunda linha —
        // reusa esta mesma, tenta de novo a partir da aplicação de
        // capacidade.
        entitlement = existingForOrder;
    } else {
        // CRIAÇÃO FRESCA (nenhuma linha existe ainda pra este pedido).
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
            // status, já está correto). Isto SÓ acontece na criação fresca —
            // uma retomada nunca refaz este passo (já foi feito).
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
            [order.guild_id, orderId, order.user_id, ENTITLEMENT_STATUS.PENDING_PROVISIONING, toSqliteDatetime(activatedAt), toSqliteDatetime(expiresAt)]
        );
        entitlement = getEntitlementByOrder(orderId);
    }

    // Revalidação de exclusividade IMEDIATAMENTE antes de promover —
    // fresca ou retomada, tanto faz: entre a tentativa original (que
    // criou esta linha PENDING_PROVISIONING, possivelmente há muito
    // tempo) e agora, uma OUTRA compra deste mesmo usuário pode ter virado
    // 'active' nesse intervalo. Promover esta de qualquer forma criaria
    // uma segunda linha 'active' — nunca permitido. Se isso acontecer,
    // lança o mesmo EntitlementConflictError de sempre; esta linha
    // continua PENDING_PROVISIONING pra sempre (não é apagada — decisão
    // #16 da Fase 7, nunca destruir evidência; precisa de reconciliação
    // manual, o mesmo já valia antes desta correção pra qualquer outro
    // tipo de falha).
    const currentActiveBeforePromote = getActiveEntitlement(order.user_id);
    if (currentActiveBeforePromote && currentActiveBeforePromote.id !== entitlement.id) {
        throw new EntitlementConflictError(
            `Usuário ${order.user_id} já tem outro entitlement ativo (#${currentActiveBeforePromote.id}) — não é possível promover o entitlement #${entitlement.id} (pendente) para ativo sem violar a exclusividade.`
        );
    }

    // Aplica a capacidade ANTES de promover — se lançar (snapshot
    // corrompido, falha de escrita), a linha permanece
    // PENDING_PROVISIONING e o erro sobe pro chamador (ProvisioningManager),
    // exatamente como qualquer outra falha de grant() já fazia.
    const snapshot = JSON.parse(order.product_snapshot);
    capacityManager.writeUserCapacity(order.user_id, {
        maxBots: snapshot.maxBots, maxRam: snapshot.maxRam, maxCpu: snapshot.maxCpu,
    });

    // Só agora, com a capacidade real já escrita, promove pra ACTIVE.
    run("UPDATE commerce_entitlements SET status = ?, updated_at = datetime('now') WHERE id = ?", [ENTITLEMENT_STATUS.ACTIVE, entitlement.id]);
    const finalEntitlement = getEntitlement(entitlement.id);

    recordAuditEvent({
        userId: null,
        event: 'commerce:entitlement_granted',
        details: JSON.stringify({
            orderId, entitlementId: finalEntitlement.id, userId: order.user_id,
            renewalOf: order.renewal_of_entitlement_id || null,
            activatedAt: finalEntitlement.activated_at, expiresAt: finalEntitlement.expires_at,
        }),
        severity: 'info',
    });
    return finalEntitlement;
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
    getRenewalEligibleEntitlement,
    markRenewalReminderSent,
    grant,
    recomputeUserCapacity,
    expireEntitlement,
    revokeEntitlement,
    _toSqliteDatetime: toSqliteDatetime,
    _fromSqliteDatetime: fromSqliteDatetime,
    _addOneMonth: addOneMonth,
};
