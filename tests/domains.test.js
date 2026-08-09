const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Testa a lógica de match dos domínios sem carregar discord.js.
 * Replica as listas EXACT/PREFIXES dos módulos de domínio.
 */
const DOMAINS = {
    sales: {
        exact: [
            'sales_buy_plan', 'sales_select_plan', 'sales_plan_choice', 'sales_view_plans',
            'sales_apply_coupon_global', 'sales_apply_coupon', 'modal_sales_apply_coupon',
            'sales_pay', 'sales_send_receipt', 'sales_cancel_order',
        ],
        prefixes: ['modal_sales_'],
    },
    affiliate: {
        exact: ['affiliate_panel', 'affiliate_set_referrer', 'modal_affiliate_set_referrer', 'affiliate_redeem'],
        prefixes: ['modal_affiliate_'],
    },
    admin: {
        exact: [
            'admin_view_orders', 'admin_order_select', 'admin_config_pix', 'modal_admin_config_pix',
            'admin_stats', 'admin_settings', 'admin_security_logs', 'admin_manage_plans',
            'modal_admin_add_plan', 'admin_set_user_plan', 'modal_admin_set_user_plan',
            'admin_manage_coupons', 'modal_admin_add_coupon',
        ],
        prefixes: ['admin_approve_', 'admin_reject_', 'modal_admin_'],
    },
    bots: {
        exact: ['my_bots', 'select_my_bot'],
        prefixes: [
            'bot_collabs_', 'bot_panel_', 'bot_start_', 'bot_stop_', 'bot_restart_',
            'bot_logs_', 'bot_stats_', 'bot_backup_', 'bot_github_', 'bot_suspend_',
            'bot_delete_', 'confirm_delete_',
        ],
    },
    files: {
        exact: [],
        prefixes: [
            'bot_files_', 'files_nav_', 'files_select_', 'files_create_file_',
            'file_view_', 'file_download_', 'file_rename_', 'file_delete_',
        ],
    },
};

function match(domain, customId) {
    if (domain.exact.includes(customId)) return true;
    return domain.prefixes.some((p) => customId.startsWith(p));
}

test('domain match tables cover primary flows and ignore unknown ids', () => {
    assert.ok(match(DOMAINS.sales, 'sales_buy_plan'));
    assert.ok(match(DOMAINS.affiliate, 'affiliate_panel'));
    assert.ok(match(DOMAINS.admin, 'admin_approve_42'));
    assert.ok(match(DOMAINS.bots, 'my_bots'));
    assert.ok(match(DOMAINS.bots, 'bot_start_abc'));
    assert.ok(match(DOMAINS.files, 'bot_files_xyz'));
    assert.equal(match(DOMAINS.sales, 'totally_unknown'), false);
    assert.equal(match(DOMAINS.bots, 'sales_buy_plan'), false);
});

test('no two primary exact ids collide across domains', () => {
    const seen = new Map();
    for (const [name, d] of Object.entries(DOMAINS)) {
        for (const id of d.exact) {
            assert.equal(seen.has(id), false, `collision on ${id} (${seen.get(id)} vs ${name})`);
            seen.set(id, name);
        }
    }
});
