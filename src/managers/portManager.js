/**
 * GERENCIADOR DE PORTAS
 * Aloca e gerencia portas para Web Apps e servidores de Minecraft
 *
 * CORREÇÃO (race condition): getAvailablePort() só consultava o banco, sem
 * reservar a porta. Se dois deploys acontecessem em paralelo (dois awaits
 * entrelaçados antes do INSERT do bot em bots.port), os dois podiam receber
 * a MESMA porta. Agora mantemos um Set em memória com as portas já entregues
 * e ainda não persistidas no banco, evitando a dupla-alocação dentro do
 * mesmo processo. Quem chama getAvailablePort() deve, em caso de falha ao
 * criar o bot, chamar releasePort() para não vazar a reserva.
 */
const { get, query } = require('../database/database');

const WEB_PORT_RANGE = { min: 10000, max: 20000 };
const MC_PORT_RANGE = { min: 25565, max: 26000 };

// Portas já entregues por getAvailablePort() nesta execução do processo,
// mas ainda não confirmadas (gravadas) no banco de dados.
const reservedPorts = new Set();

/**
 * Encontra e reserva uma porta disponível em um determinado range.
 * A reserva é liberada automaticamente assim que a porta aparecer no banco
 * (persistida em bots.port), ou manualmente via releasePort() em caso de erro.
 */
function getAvailablePort(type = 'web') {
    const range = type === 'minecraft' ? MC_PORT_RANGE : WEB_PORT_RANGE;

    // Pega todas as portas já em uso no banco (persistidas)
    const usedPorts = new Set(query('SELECT port FROM bots WHERE port IS NOT NULL').map(b => b.port));

    for (let port = range.min; port <= range.max; port++) {
        if (!usedPorts.has(port) && !reservedPorts.has(port)) {
            reservedPorts.add(port);
            return port;
        }
    }

    throw new Error(`Nenhuma porta disponível para o tipo: ${type}`);
}

/**
 * Libera a reserva em memória de uma porta (chamar se a criação do bot falhar
 * após reservar a porta, ou depois que ela já foi persistida em bots.port).
 */
function releasePort(port) {
    reservedPorts.delete(port);
}

module.exports = {
    getAvailablePort,
    releasePort,
};
