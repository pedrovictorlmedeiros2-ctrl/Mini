/**
 * GERENCIADOR DE PROXY REVERSO
 * Gerencia o roteamento de domínios para Web Apps hospedados
 *
 * CORREÇÃO DE PERFORMANCE: a versão anterior chamava createProxyMiddleware()
 * de novo A CADA REQUISIÇÃO, criando um proxy HTTP inteiro (com seus próprios
 * agents/sockets) só pra processar uma única request e jogar fora. Isso
 * desperdiça CPU/memória a cada request e impede reuso de conexões (keep-alive)
 * com o app de destino. Agora os middlewares são criados uma única vez por
 * porta de destino e reaproveitados (cache), com limpeza automática quando o
 * bot correspondente sai do ar.
 */
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { query } = require('../database/database');
const app = express();

// Cache de middlewares de proxy já criados, indexados pela porta de destino.
const proxyCache = new Map();

function getOrCreateProxy(targetPort) {
    let proxy = proxyCache.get(targetPort);
    if (!proxy) {
        proxy = createProxyMiddleware({
            target: `http://127.0.0.1:${targetPort}`,
            changeOrigin: true,
            ws: true, // Suporte a WebSockets
            logLevel: 'silent',
        });
        proxyCache.set(targetPort, proxy);
    }
    return proxy;
}

/**
 * Inicializa o servidor de proxy
 */
function startProxyServer(port = 80) {
    app.use(async (req, res, next) => {
        const host = req.headers.host;

        // Busca o bot/app associado a este domínio
        const bot = query("SELECT * FROM bots WHERE domain = ? AND status = 'online'", [host])[0];

        if (bot && bot.port) {
            return getOrCreateProxy(bot.port)(req, res, next);
        }

        res.status(404).send('<h1>404 - Aplicação não encontrada ou offline</h1>');
    });

    // Limpa periodicamente entradas do cache cujo destino não corresponde mais
    // a nenhum bot online, evitando crescimento ilimitado do Map com o tempo
    // (bots são excluídos, portas são reatribuídas a outros bots, etc.).
    setInterval(() => {
        const activePorts = new Set(query("SELECT port FROM bots WHERE status = 'online' AND port IS NOT NULL").map(b => b.port));
        for (const cachedPort of proxyCache.keys()) {
            if (!activePorts.has(cachedPort)) proxyCache.delete(cachedPort);
        }
    }, 5 * 60 * 1000);

    app.listen(port, () => {
        console.log(`🌐 Proxy Reverso rodando na porta ${port}`);
    });
}

module.exports = {
    startProxyServer
};
