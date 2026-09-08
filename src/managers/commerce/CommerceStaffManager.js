/**
 * COMMERCE STAFF MANAGER (Sistema Comercial — Fase 2)
 *
 * Permissão comercial (`COMMERCE_STAFF`) independente de `Administrator`
 * — decisão de negócio confirmada: aprovação financeira não deveria
 * depender exclusivamente do papel `admin` da hierarquia geral da
 * plataforma (`userManager.ROLE_HIERARCHY`, NÃO alterada por este
 * módulo). `COMMERCE_STAFF` é um grant ADITIVO, concedido/revogado só
 * por quem já é `admin`.
 *
 * hasCommercePermission() é o ponto único que todo manager comercial
 * (PaymentManager, e no futuro commerce.js) deve checar internamente —
 * nunca confiar só na camada de UI ter checado antes (mesmo princípio
 * defensivo de `canManageBot()` em userManager.js).
 */
const { get, run, query } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');
const { hasPermission } = require('../userManager');

/**
 * Concede COMMERCE_STAFF a um usuário. Só quem já é `admin` (hierarquia
 * geral existente) pode conceder — nunca outro COMMERCE_STAFF concedendo
 * pra si mesmo ou pra terceiros (evita escalonamento lateral).
 *
 * Idempotente: se o usuário já tem o grant ativo, não faz nada (retorna
 * a linha existente, sem duplicar auditoria). Se existia mas foi
 * revogado antes, "re-concede" limpando revoked_at/revoked_by
 * (soft-revoke reversível — nunca perde o histórico de quando foi
 * revogado da primeira vez, porque isso já foi auditado no momento da
 * revogação).
 */
function grant(targetUserId, grantedByUserId, guildId = null) {
    if (!hasPermission(grantedByUserId, 'admin')) {
        throw new Error('Só administradores podem conceder COMMERCE_STAFF.');
    }
    if (!targetUserId) throw new Error('CommerceStaffManager.grant requer targetUserId.');

    const existing = get('SELECT * FROM commerce_staff WHERE user_id = ?', [targetUserId]);
    if (existing && existing.revoked_at === null) {
        return existing; // já ativo — no-op idempotente, sem duplicar auditoria
    }

    if (existing) {
        run(
            "UPDATE commerce_staff SET guild_id = ?, granted_by = ?, granted_at = datetime('now'), revoked_by = NULL, revoked_at = NULL WHERE user_id = ?",
            [guildId, grantedByUserId, targetUserId]
        );
    } else {
        run(
            'INSERT INTO commerce_staff (user_id, guild_id, granted_by) VALUES (?, ?, ?)',
            [targetUserId, guildId, grantedByUserId]
        );
    }

    recordAuditEvent({
        userId: grantedByUserId,
        event: 'commerce:staff_granted',
        details: JSON.stringify({ targetUserId, guildId }),
        severity: 'info',
    });
    return get('SELECT * FROM commerce_staff WHERE user_id = ?', [targetUserId]);
}

/** Revoga COMMERCE_STAFF — soft-revoke, nunca apaga a linha (histórico auditável). */
function revoke(targetUserId, revokedByUserId) {
    if (!hasPermission(revokedByUserId, 'admin')) {
        throw new Error('Só administradores podem revogar COMMERCE_STAFF.');
    }
    const existing = get('SELECT * FROM commerce_staff WHERE user_id = ?', [targetUserId]);
    if (!existing || existing.revoked_at !== null) {
        return existing || null; // nunca teve, ou já revogado — no-op
    }

    run(
        "UPDATE commerce_staff SET revoked_by = ?, revoked_at = datetime('now') WHERE user_id = ?",
        [revokedByUserId, targetUserId]
    );
    recordAuditEvent({
        userId: revokedByUserId,
        event: 'commerce:staff_revoked',
        details: JSON.stringify({ targetUserId }),
        severity: 'info',
    });
    return get('SELECT * FROM commerce_staff WHERE user_id = ?', [targetUserId]);
}

function isActiveCommerceStaff(userId) {
    const row = get('SELECT * FROM commerce_staff WHERE user_id = ? AND revoked_at IS NULL', [userId]);
    return !!row;
}

/**
 * Checagem central de permissão comercial — `admin` sempre pode tudo;
 * `COMMERCE_STAFF` cobre as ações comerciais (aprovar/recusar
 * pagamento, ver/decriptar comprovante, retry de provisionamento — ver
 * matriz de permissões da arquitetura). `moderator` NÃO herda
 * automaticamente (decisão explícita: a extensão é uma alternativa a
 * `Administrator`, não uma ampliação pra `moderator`).
 *
 * O parâmetro `action` não diferencia nada na v1 (só existe uma
 * categoria de ação comercial) — reservado pra quando o four-eyes
 * (decisão #8, não implementado agora) precisar diferenciar "aprovar
 * valor alto" de "aprovar valor normal" sem quebrar quem já chama esta
 * função.
 */
function hasCommercePermission(userId, action = 'approve_payment') {
    if (hasPermission(userId, 'admin')) return true;
    return isActiveCommerceStaff(userId);
}

function listActiveStaff(guildId = null) {
    if (guildId) {
        return query('SELECT * FROM commerce_staff WHERE revoked_at IS NULL AND (guild_id = ? OR guild_id IS NULL)', [guildId]);
    }
    return query('SELECT * FROM commerce_staff WHERE revoked_at IS NULL');
}

module.exports = {
    grant,
    revoke,
    isActiveCommerceStaff,
    hasCommercePermission,
    listActiveStaff,
};
