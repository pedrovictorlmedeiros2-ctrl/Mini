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

module.exports = { getConfig, saveChannelStructure, isConfigured };
