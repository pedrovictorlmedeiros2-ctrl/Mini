/**
 * THREAT DECISION POLICY (SecurityMonitor — Fase 2)
 *
 * É o ÚNICO lugar onde um resultado do Groq pode ter QUALQUER efeito no
 * resto do sistema — e mesmo aqui, o único efeito possível é alimentar
 * `SecurityEngine.reportSignal()` de volta, exatamente como qualquer outra
 * fonte de sinal (fileManager, processManager, cgroup). Este arquivo:
 *
 * - NUNCA importa nem chama IncidentResponseManager diretamente.
 * - NUNCA apaga arquivo, restaura snapshot, revoga credencial, executa
 *   comando ou altera o banco além de um INSERT de auditoria.
 * - NUNCA deixa o Groq escolher botId/caminho — o botId vem de quem chama
 *   (SecurityMonitor, que leu do audit_log — fonte interna confiável).
 * - NUNCA usa o texto livre (`summary`) do Groq pra decidir nada — só os
 *   campos enumerados (classification/confidence) participam da decisão.
 *
 * Por que isto nunca pode causar CRITICAL sozinho, nem em combinação:
 * os codes usados aqui (`groq_suggested_suspicious`/`groq_suggested_high`)
 * são DELIBERADAMENTE deixados de fora do mapa SIGNAL_CATEGORY do
 * SecurityEngine (arquivo não modificado nesta fase). Caem na categoria
 * 'unknown' por padrão — que a regra de correlação do SecurityEngine já
 * exclui explicitamente da decisão de CRITICAL (código pré-existente,
 * não alterado). Repetição ainda pode levar um code do Groq a HIGH
 * (satisfaz "Groq pode sugerir HIGH"), mas nunca a CRITICAL, nem sozinho
 * nem correlacionado com outra coisa.
 */
const { get } = require('../../../database/database');
const { recordAuditEvent } = require('../../auditManager');
const { sendAlert } = require('../../alertManager');
const { reportSignal } = require('../SecurityEngine');
const config = require('../../../../config');

// Mapa fixo e pequeno — nunca gerado a partir de texto livre do Groq.
const CODE_FOR_CLASSIFICATION = Object.freeze({
    likely_malicious: 'groq_suggested_high',
    suspicious: 'groq_suggested_suspicious',
});

/**
 * @param {string} botId - vem do pipeline interno (SignalCollector), nunca do Groq
 * @param {object} groqResult - já validado por GroqThreatAnalyzer.validateAndSanitizeResponse
 * @returns {{forwarded: boolean, forwardedCode: string|null, humanReviewAlerted: boolean}}
 */
function applyThreatDecision(botId, groqResult) {
    const cfg = config.security.groqMonitor;
    let forwarded = false;
    let forwardedCode = null;
    let humanReviewAlerted = false;

    const eligibleCode = groqResult.available ? CODE_FOR_CLASSIFICATION[groqResult.classification] : null;
    const meetsConfidence = typeof groqResult.confidence === 'number' && groqResult.confidence >= cfg.minConfidenceToForwardSignal;

    if (eligibleCode && meetsConfidence) {
        forwardedCode = eligibleCode;
        try {
            // Reentra no MESMO pipeline determinístico de sempre — nenhuma
            // regra nova, nenhum atalho. O SecurityEngine é quem decide a
            // severidade final, exatamente como faz pra qualquer outra fonte.
            reportSignal({
                botId,
                source: 'groq',
                code: eligibleCode,
                details: {
                    confidence: groqResult.confidence,
                    categories: groqResult.categories,
                    reasonCodes: groqResult.reasonCodes,
                    recommendedAction: groqResult.recommendedAction,
                },
            });
            forwarded = true;
        } catch (err) {
            recordAuditEvent({
                userId: null,
                event: 'groq_monitor:forward_failed',
                details: JSON.stringify({ botId, error: err.message }),
                severity: 'warning',
            });
        }
    }

    if (groqResult.available && groqResult.needsHumanReview) {
        humanReviewAlerted = true;
        const bot = get('SELECT name, code FROM bots WHERE id = ?', [botId]);
        const label = bot ? `${bot.name} (${bot.code})` : `bot ${botId}`;
        // Alerta SÓ pro canal administrativo — nunca DM ao dono do bot por
        // causa de uma sugestão do Groq (isso ficaria reservado a
        // incidentes de verdade, via Kamikaze, pra não gerar alarme falso
        // pro cliente por causa de uma heurística auxiliar).
        sendAlert(
            '🔎 Groq sugere revisão humana',
            `O analisador auxiliar (Groq) sinalizou que o bot ${label} pode precisar de revisão manual.\n` +
            `Classificação sugerida: **${groqResult.classification}** (confiança ${groqResult.confidence.toFixed(2)}).\n` +
            `Ação recomendada pelo Groq: ${groqResult.recommendedAction} (apenas sugestão — nenhuma ação automática foi tomada).\n` +
            `Resumo: ${groqResult.summary || '(sem resumo)'}`,
            'warning'
        );
    }

    recordAuditEvent({
        userId: null,
        event: 'groq_monitor:decision',
        details: JSON.stringify({
            botId,
            available: groqResult.available,
            classification: groqResult.classification,
            confidence: groqResult.confidence,
            forwarded,
            forwardedCode,
            needsHumanReview: !!groqResult.needsHumanReview,
            unavailableReason: groqResult.unavailableReason || null,
        }),
        severity: 'info',
    });

    return { forwarded, forwardedCode, humanReviewAlerted };
}

module.exports = { applyThreatDecision, CODE_FOR_CLASSIFICATION };
