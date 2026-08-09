/**
 * AUTENTICAÇÃO DO PAINEL WEB — extraído de panelServer.js pra ser testável
 * isoladamente (ver tests/panelAuth.test.js).
 *
 * Aceita SOMENTE token via header (X-Panel-Token ou Authorization: Bearer).
 * ?token= na URL foi removido de propósito: query strings costumam parar em
 * logs de acesso, histórico do navegador, proxies e ferramentas de
 * monitoramento, vazando o token do painel.
 */
const crypto = require('crypto');

/**
 * Extrai o token fornecido pelo cliente a partir dos headers HTTP.
 * @param {Record<string, string>} headers - req.headers (lowercase, como o Express entrega)
 * @returns {string} token fornecido, ou string vazia se nenhum foi enviado
 */
function extractProvidedToken(headers = {}) {
    return (
        headers['x-panel-token'] ||
        (headers.authorization || '').replace(/^Bearer\s+/i, '') ||
        ''
    );
}

/**
 * Confere se o token fornecido bate com o esperado.
 *
 * CORREÇÃO DE SEGURANÇA (achado em auditoria): `provided === expected` compara
 * string por string e retorna assim que encontra a primeira diferença — o
 * tempo de resposta varia (bem pouco, mas mensurável em muitas tentativas)
 * conforme quantos caracteres iniciais acertam, o que em teoria permite um
 * ataque de timing pra descobrir o token caractere por caractere. Usamos
 * crypto.timingSafeEqual, que sempre compara todos os bytes.
 * @param {string} provided
 * @param {string|undefined} expected
 * @returns {boolean}
 */
function isValidPanelToken(provided, expected) {
    if (!expected || typeof provided !== 'string') return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // timingSafeEqual exige buffers do mesmo tamanho — se os tamanhos já
    // diferem, o token está errado, mas ainda comparamos contra um buffer
    // dummy do mesmo tamanho de `a` pra não vazar a informação "tamanho
    // bateu ou não" através de um retorno antecipado.
    if (a.length !== b.length) {
        crypto.timingSafeEqual(a, Buffer.alloc(a.length));
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

module.exports = { extractProvidedToken, isValidPanelToken };
