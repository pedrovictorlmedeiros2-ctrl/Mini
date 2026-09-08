/**
 * INCIDENT RESPONSE MANAGER (Kamikaze Mode)
 *
 * Orquestrador do fluxo completo de resposta a um incidente CRITICAL. Só é
 * acionado pelo SecurityEngine (nunca decide sozinho que algo é CRITICAL —
 * essa decisão já foi tomada antes de chegar aqui). Conduz a máquina de
 * estados abaixo, delegando cada etapa a um manager especializado, e nunca
 * segue adiante depois de uma falha — qualquer etapa que falhar entra em
 * FAILED_SAFE (bot permanece parado + suspenso, nada mais é tentado).
 *
 * Estados: DETECTED -> CONTAINING -> QUARANTINING -> LOCATING_SNAPSHOT ->
 * RESTORING -> CREDENTIAL_REVOKING -> RESTARTING -> NOTIFYING ->
 * RESOLVED | RESOLVED_PARTIAL | FAILED_SAFE
 *
 * Cada transição é gravada em `incidents` (linha única, atualizada) E em
 * `audit_log` via recordAuditEvent (append-only, nunca podado).
 */
const { run, get } = require('../../database/database');
const { recordAuditEvent } = require('../auditManager');
const { sendAlert, notifyBotOwner, notifyKamikazeIncident } = require('../alertManager');
const QuarantineManager = require('./QuarantineManager');
const SnapshotManager = require('./SnapshotManager');
const RecoveryManager = require('./RecoveryManager');
const CredentialRevoker = require('./CredentialRevoker');

// botId -> true enquanto um incidente está sendo processado. Checado e
// setado de forma SÍNCRONA, antes de qualquer await — mesma classe de
// proteção que intentionalStop/restartAttempts já usam em
// processManager.js, pra nunca rodar duas respostas em paralelo pro mesmo
// bot (ex.: dois sinais CRITICAL quase simultâneos).
const activeIncidents = new Map();

const TERMINAL_STATUSES = ['resolved', 'resolved_partial', 'failed_safe'];

// Defesa em profundidade: reportSignal() (SecurityEngine.js) já sanitiza o
// `details` de um sinal antes de repassar pra cá, mas handleCriticalIncident
// é exportado e pode ser chamado diretamente (inclusive pelos próprios
// testes) — nunca deve confiar só no chamador pra garantir que o payload é
// serializável.
function safeStringify(value) {
    try {
        return JSON.stringify(value);
    } catch (err) {
        try {
            return JSON.stringify({ __unserializable: true, reason: err.message });
        } catch {
            return '{"__unserializable":true}';
        }
    }
}

function createIncidentRow(botId, severity, evidence) {
    const result = run(
        `INSERT INTO incidents (bot_id, severity, status, evidence_json) VALUES (?, ?, 'detected', ?)`,
        [botId, severity, safeStringify(evidence)]
    );
    return result.lastInsertRowid;
}

function updateIncident(incidentId, fields) {
    const columns = Object.keys(fields);
    if (!columns.length) return;
    const setClause = columns.map((c) => `${c} = ?`).join(', ');
    run(`UPDATE incidents SET ${setClause} WHERE id = ?`, [...columns.map((c) => fields[c]), incidentId]);
}

function auditStep(incidentId, botId, status, details = '') {
    updateIncident(incidentId, { status });
    recordAuditEvent({
        userId: null,
        event: `kamikaze:${status}`,
        details: JSON.stringify({ incidentId, botId, details }),
        severity: status === 'failed_safe' ? 'critical' : 'warning',
    });
}

/**
 * Encerra o incidente em estado seguro (não tentou/não conseguiu concluir
 * a recuperação). O bot permanece parado e suspenso — nunca reiniciado
 * "às cegas". Notifica dono + admin explicando que a resposta automática
 * não pôde ser concluída.
 */
async function failSafe(incidentId, bot, reason) {
    updateIncident(incidentId, { status: 'failed_safe', resolved_at: new Date().toISOString() });
    recordAuditEvent({
        userId: null,
        event: 'kamikaze:failed_safe',
        details: JSON.stringify({ incidentId, botId: bot?.id, reason }),
        severity: 'critical',
    });

    if (!bot) return;

    // Garante que o bot fica travado (idempotente — pode já estar suspenso).
    run(
        "UPDATE bots SET suspended = 1, suspended_reason = ? WHERE id = ?",
        [`Incidente de segurança #${incidentId}: resposta automática não pôde ser concluída (${reason}). Aguardando revisão manual.`, bot.id]
    );

    const title = `🆘 Kamikaze Mode: resposta automática incompleta (bot ${bot.name})`;
    const msg =
        `Detectamos comportamento potencialmente malicioso no bot \`${bot.name}\` (\`${bot.code}\`) e iniciamos a ` +
        `resposta automática, mas não foi possível concluí-la com segurança (motivo: ${reason}). ` +
        `O bot permanece **isolado e suspenso** por precaução — nenhuma ação adicional foi tentada. ` +
        `Um administrador precisa revisar manualmente. ID do incidente: ${incidentId}.`;
    await Promise.all([
        sendAlert(title, msg, 'error'),
        notifyBotOwner(bot.id,
            '⚠️ Comportamento potencialmente malicioso detectado no seu bot',
            `Detectamos comportamento potencialmente malicioso no seu bot e o isolamos por segurança. ` +
            `A restauração automática não pôde ser concluída — o bot permanece parado até a nossa equipe revisar o caso. ` +
            `ID do incidente: ${incidentId}.`
        ),
    ]);
}

/**
 * Ponto de entrada, chamado pelo SecurityEngine quando um sinal é
 * classificado como CRITICAL.
 *
 * @param {string} botId
 * @param {{source:string, code:string, details:object, rule:string, evidence:Array}} evidencePayload
 */
async function handleCriticalIncident(botId, evidencePayload) {
    if (activeIncidents.has(botId)) {
        // Já existe uma resposta em andamento pra este bot — coalesce (não
        // roda duas vezes em paralelo). Só registra, não cria um segundo
        // incidente.
        recordAuditEvent({
            userId: null,
            event: 'kamikaze:coalesced',
            details: safeStringify({ botId, evidencePayload }),
            severity: 'warning',
        });
        return;
    }
    activeIncidents.set(botId, true);

    try {
        // CORREÇÃO DE SEGURANÇA (achado em validação: "FOREIGN KEY constraint
        // failed"): `incidents.bot_id` tem FK pra `bots(id)`. A versão
        // anterior criava a linha de incidente ANTES de checar se o bot
        // existe, e fazia isso FORA deste try/finally — resultado: um sinal
        // CRITICAL pra um botId que não existe (ou que já foi apagado)
        // lançava a violação de FK direto no INSERT, propagava pra fora da
        // função sem passar pelo `finally`, e o lock em `activeIncidents`
        // NUNCA era liberado — qualquer sinal legítimo futuro pro mesmo
        // botId (inclusive depois de um bot de verdade ser criado com esse
        // id) ficava coalescido/ignorado pra sempre, silenciosamente, até o
        // processo reiniciar. Agora: valida o bot ANTES de tocar em
        // `incidents`, e todo o corpo está dentro do try/finally — qualquer
        // erro inesperado (inclusive um JSON.stringify que falhe no
        // evidence_json) ainda libera o lock e ainda fica registrado no
        // audit_log, nunca falha silenciosamente.
        let bot;
        try {
            bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
        } catch (err) {
            recordAuditEvent({
                userId: null,
                event: 'kamikaze:failed_safe',
                details: safeStringify({ botId, reason: `erro ao consultar o bot no banco: ${err.message}`, evidencePayload }),
                severity: 'critical',
            });
            return;
        }
        if (!bot) {
            recordAuditEvent({
                userId: null,
                event: 'kamikaze:failed_safe',
                details: safeStringify({ botId, reason: 'bot não encontrado no banco — nenhum incidente foi criado (violaria a FK incidents.bot_id -> bots.id)', evidencePayload }),
                severity: 'critical',
            });
            return;
        }

        let incidentId;
        try {
            incidentId = createIncidentRow(botId, 'CRITICAL', evidencePayload);
        } catch (err) {
            recordAuditEvent({
                userId: null,
                event: 'kamikaze:failed_safe',
                details: JSON.stringify({ botId, reason: `falha ao registrar o incidente no banco: ${err.message}` }),
                severity: 'critical',
            });
            return;
        }

        // ── CONTAINING ───────────────────────────────────────────────────
        // Suspende ANTES de qualquer outra coisa — bloqueia qualquer
        // startBot() concorrente (clique manual, auto-restart de crash
        // loop já em voo) enquanto o resto do fluxo roda.
        run(
            "UPDATE bots SET suspended = 1, suspended_reason = ? WHERE id = ?",
            [`Incidente de segurança #${incidentId} em andamento.`, botId]
        );

        auditStep(incidentId, botId, 'containing', evidencePayload.code);

        const { stopBot, activeProcesses } = require('../processManager');
        stopBot(botId);

        // Espera o processo realmente sair (mesmo padrão/teto de
        // restartBot() em processManager.js) — nunca quarentena uma pasta
        // enquanto o processo pode ainda estar vivo/saindo.
        const stopDeadline = Date.now() + 8000;
        while (Date.now() < stopDeadline && activeProcesses.has(botId)) {
            await new Promise((r) => setTimeout(r, 200));
        }
        if (activeProcesses.has(botId)) {
            await failSafe(incidentId, bot, 'não foi possível confirmar que o processo do bot parou a tempo');
            return;
        }

        // ── QUARANTINING ─────────────────────────────────────────────────
        auditStep(incidentId, botId, 'quarantining');
        bot = get('SELECT * FROM bots WHERE id = ?', [botId]); // relê (suspended já mudou)
        let quarantineResult;
        try {
            quarantineResult = QuarantineManager.quarantine(bot, incidentId);
        } catch (err) {
            await failSafe(incidentId, bot, `falha ao mover o workspace para quarentena: ${err.message}`);
            return;
        }
        if (quarantineResult.quarantineEntryId) {
            updateIncident(incidentId, { quarantine_entry_id: quarantineResult.quarantineEntryId });
        }

        // ── LOCATING_SNAPSHOT ────────────────────────────────────────────
        auditStep(incidentId, botId, 'locating_snapshot');
        const snapshot = SnapshotManager.findLastSafeSnapshot(botId);
        if (!snapshot) {
            await failSafe(incidentId, bot, 'nenhum snapshot seguro encontrado para restauração automática');
            return;
        }
        updateIncident(incidentId, { snapshot_used_id: snapshot.id });

        // ── RESTORING ────────────────────────────────────────────────────
        auditStep(incidentId, botId, 'restoring', `snapshot #${snapshot.id}`);
        const restoreResult = await RecoveryManager.restoreSafeSnapshot(bot, snapshot);
        if (!restoreResult.success) {
            await failSafe(incidentId, bot, `falha ao restaurar o snapshot seguro: ${restoreResult.error}`);
            return;
        }

        // ── CREDENTIAL_REVOKING ──────────────────────────────────────────
        auditStep(incidentId, botId, 'credential_revoking');
        let credentialAction = null;
        try {
            const revokeResult = CredentialRevoker.revoke(bot);
            credentialAction = JSON.stringify({
                envVarsWiped: revokeResult.envVarsWiped,
                tokenRevoked: revokeResult.tokenRevoked,
                envSnapshotEncrypted: revokeResult.envSnapshotEncrypted,
            });
        } catch (err) {
            // Best-effort: falha aqui não bloqueia o fluxo — o risco de
            // credencial já foi reduzido pelas etapas anteriores (bot
            // parado + isolado). Só registra.
            credentialAction = JSON.stringify({ error: err.message });
        }
        updateIncident(incidentId, { credential_action: credentialAction });

        // ── RESTARTING ───────────────────────────────────────────────────
        auditStep(incidentId, botId, 'restarting');
        let started = false;
        const freshBot = get('SELECT * FROM bots WHERE id = ?', [botId]);
        if (!freshBot.token) {
            // Sem token (acabou de ser revogado por precaução, ou já não
            // tinha) — NUNCA tenta reiniciar sem credencial. Decisão
            // confirmada: mais seguro deixar parado do que arriscar rodar
            // com um token que pode já estar exposto. Re-suspende com um
            // motivo claro em vez de só deixar offline sem contexto.
            run(
                "UPDATE bots SET suspended = 1, suspended_reason = ? WHERE id = ?",
                [`Aguardando nova configuração após incidente #${incidentId} (token do Discord foi revogado por segurança — cadastre um novo).`, botId]
            );
        } else {
            run('UPDATE bots SET suspended = 0, suspended_reason = NULL WHERE id = ?', [botId]);
            const { startBot } = require('../processManager');
            try {
                await startBot(botId);
                started = true;
            } catch (err) {
                run(
                    "UPDATE bots SET suspended = 1, suspended_reason = ? WHERE id = ?",
                    [`Aguardando nova configuração após incidente #${incidentId} (${err.message})`, botId]
                );
            }
        }

        // ── NOTIFYING ────────────────────────────────────────────────────
        auditStep(incidentId, botId, 'notifying');
        await notifyKamikazeIncident(botId, { id: incidentId, restarted: started, snapshot });

        // ── RESOLVED / RESOLVED_PARTIAL ──────────────────────────────────
        const finalStatus = started ? 'resolved' : 'resolved_partial';
        updateIncident(incidentId, { status: finalStatus, resolved_at: new Date().toISOString() });
        recordAuditEvent({
            userId: null,
            event: `kamikaze:${finalStatus}`,
            details: JSON.stringify({ incidentId, botId, started, snapshotId: snapshot.id }),
            severity: 'warning',
        });
    } finally {
        activeIncidents.delete(botId);
    }
}

/**
 * Reconciliação no boot: se o processo do Atlantic Host caiu no meio de um
 * incidente (o lock em memória se perde no restart), qualquer incidente
 * que ficou preso num estado não-terminal é marcado failed_safe — nunca
 * tenta resumir um incidente parcialmente executado às cegas. Mesmo
 * espírito do syncStatusOnStartup() já existente em processManager.js.
 */
async function reconcileStuckIncidents() {
    const { query } = require('../../database/database');
    const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
    const stuck = query(
        `SELECT * FROM incidents WHERE status NOT IN (${placeholders})`,
        TERMINAL_STATUSES
    );
    for (const incident of stuck) {
        const bot = get('SELECT * FROM bots WHERE id = ?', [incident.bot_id]);
        await failSafe(incident.id, bot, `incidente interrompido por reinício do Atlantic Host (estava em '${incident.status}')`);
    }
    if (stuck.length) {
        console.warn(`[Kamikaze] ${stuck.length} incidente(s) preso(s) de uma execução anterior marcados como failed_safe.`);
    }
}

module.exports = { handleCriticalIncident, reconcileStuckIncidents };
