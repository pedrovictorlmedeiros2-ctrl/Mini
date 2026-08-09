/**
 * REFERÊNCIA COMPARTILHADA DO CLIENT DO DISCORD
 *
 * Handlers de interação já têm acesso ao client via `interaction.client`, mas
 * processos em background (auto-restart, watchdog de CPU/RAM, crash loop)
 * rodam fora de qualquer interação e não tinham NENHUMA forma de mandar uma
 * DM pro dono do bot quando algo importante acontece (ex: crash loop).
 *
 * Este módulo guarda uma única referência ao client, setada uma vez em
 * index.js assim que o bot loga, e pode ser importada de qualquer manager.
 */
let client = null;

function setClient(discordClient) {
    client = discordClient;
}

function getClient() {
    return client;
}

/**
 * Tenta mandar uma DM para um usuário. Nunca lança erro (DMs fechadas,
 * usuário que saiu de todos os servidores em comum, etc. são falhas
 * esperadas e não devem derrubar quem chamou isso).
 */
async function tryDM(userId, content) {
    if (!client) return false;
    try {
        const user = await client.users.fetch(userId);
        await user.send(content);
        return true;
    } catch {
        return false;
    }
}

module.exports = { setClient, getClient, tryDM };
