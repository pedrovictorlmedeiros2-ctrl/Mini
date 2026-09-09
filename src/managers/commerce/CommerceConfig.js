/**
 * COMMERCE CONFIG (Sistema Comercial — Fase 3)
 *
 * Estrutura de canais/categorias da loja (criada pelo comando de setup,
 * `/configurar-loja`) — uma linha só, separada de `sales_config`
 * (legado). Dados Pix continuam em `sales_config` (reaproveitado,
 * arquitetura aprovada) — este módulo nunca lê nem escreve Pix.
 */
const { get, run } = require('../../database/database');

function getConfig() {
    return get('SELECT * FROM commerce_config WHERE id = 1');
}

function saveChannelStructure(fields) {
    const current = getConfig();
    const merged = { ...current, ...fields };
    run(
        `UPDATE commerce_config SET
            guild_id = ?, public_category_id = ?, sales_panel_channel_id = ?, faq_channel_id = ?,
            staff_category_id = ?, staff_panel_channel_id = ?, orders_review_channel_id = ?,
            proofs_channel_id = ?, sales_log_channel_id = ?, staff_role_id = ?
         WHERE id = 1`,
        [
            merged.guild_id, merged.public_category_id, merged.sales_panel_channel_id, merged.faq_channel_id,
            merged.staff_category_id, merged.staff_panel_channel_id, merged.orders_review_channel_id,
            merged.proofs_channel_id, merged.sales_log_channel_id, merged.staff_role_id,
        ]
    );
    return getConfig();
}

/** Verdadeiro só quando o setup já rodou (categorias/canais já existem). */
function isConfigured() {
    const cfg = getConfig();
    return !!(cfg && cfg.public_category_id && cfg.staff_category_id);
}

/**
 * FASE 9 (hardening): campos críticos que `/configurar-loja` sempre
 * grava juntos no caminho feliz, mas que podem faltar numa configuração
 * antiga/parcial (ex.: setup anterior a este campo existir, ou uma
 * falha no meio da criação de canais). Não estende `isConfigured()` —
 * fazer isso mudaria a semântica do guard de idempotência do comando de
 * setup (ele recriaria categorias inteiras, duplicando-as, só porque um
 * campo secundário está faltando, o que seria pior que o problema
 * atual). Esta função é só uma checagem separada, usada pra reparo
 * cirúrgico e aviso — nunca pra decidir se o setup completo deve rodar
 * de novo.
 */
function getMissingCriticalFields() {
    const cfg = getConfig();
    const missing = [];
    if (!cfg || !cfg.sales_log_channel_id) missing.push('sales_log_channel_id');
    return missing;
}

module.exports = { getConfig, saveChannelStructure, isConfigured, getMissingCriticalFields };
