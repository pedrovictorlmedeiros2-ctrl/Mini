/**
 * GERENCIADOR DE SAÚDE
 * Avalia a estabilidade dos bots baseado em crashes e uso de recursos
 */
const { run, get } = require('../database/database');

/**
 * Atualiza a saúde de um bot após um evento (crash ou sucesso)
 * @param {string} botId 
 * @param {string} event - 'crash' | 'watchdog' | 'heartbeat'
 */
function updateHealth(botId, event) {
    const bot = get('SELECT health_score FROM bots WHERE id = ?', [botId]);
    if (!bot) return;

    let newScore = bot.health_score;

    if (event === 'crash') newScore -= 15;
    if (event === 'watchdog') newScore -= 25;
    if (event === 'heartbeat') newScore += 2; // Recuperação gradual

    // Limites do score
    newScore = Math.max(0, Math.min(100, newScore));

    let status = 'healthy';
    if (newScore < 40) status = 'critical';
    else if (newScore < 80) status = 'warning';

    run(
        'UPDATE bots SET health_score = ?, health_status = ? WHERE id = ?',
        [newScore, status, botId]
    );
}

/**
 * Marca um bot como em Crash Loop: o auto-restart tentou repetidamente e o
 * processo continua morrendo rápido demais. Para de tentar e sinaliza que
 * precisa de intervenção manual do dono (ver processManager.js).
 */
function markCrashLoop(botId) {
    run("UPDATE bots SET health_score = 0, health_status = 'crash_loop' WHERE id = ?", [botId]);
}

/**
 * Retorna o emoji e texto de saúde
 */
function getHealthDisplay(status) {
    const displays = {
        healthy: { emoji: '🟢', text: 'Saudável' },
        warning: { emoji: '🟡', text: 'Atenção' },
        critical: { emoji: '🔴', text: 'Crítico' },
        crash_loop: { emoji: '💀', text: 'Crash Loop (parado)' },
    };
    return displays[status] || displays.healthy;
}

module.exports = { updateHealth, getHealthDisplay, markCrashLoop };
