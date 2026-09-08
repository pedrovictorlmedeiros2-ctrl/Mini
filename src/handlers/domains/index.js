/**
 * ROUTER DE DOMÍNIOS — v8.3
 */
const sales = require('./sales');
const affiliate = require('./affiliate');
const admin = require('./admin');
const bots = require('./bots');
const files = require('./files');
const commerce = require('./commerce');

const domains = [affiliate, sales, admin, bots, files, commerce];

async function routeDomain(interaction, helpers = {}) {
    const customId = interaction.customId;
    if (!customId) return false;

    for (const domain of domains) {
        if (domain.match(customId)) {
            await domain.handle(interaction, helpers);
            return true;
        }
    }
    return false;
}

module.exports = { routeDomain, domains };
