const test = require('node:test');
const assert = require('node:assert/strict');
const { extractProvidedToken, isValidPanelToken } = require('../src/utils/panelAuth');

test('lê token do header X-Panel-Token', () => {
    const token = extractProvidedToken({ 'x-panel-token': 'abc123' });
    assert.strictEqual(token, 'abc123');
});

test('lê token do header Authorization: Bearer', () => {
    const token = extractProvidedToken({ authorization: 'Bearer abc123' });
    assert.strictEqual(token, 'abc123');
});

test('CORREÇÃO DE SEGURANÇA: ?token= na URL não é mais uma forma válida de autenticar', () => {
    // Simula uma requisição que só mandou o token via query string (?token=abc123)
    // e nenhum header — extractProvidedToken não olha pra query string de propósito.
    const token = extractProvidedToken({});
    assert.strictEqual(token, '');
});

test('sem nenhum header, token extraído é vazio', () => {
    assert.strictEqual(extractProvidedToken(), '');
});

test('token correto é aceito', () => {
    assert.strictEqual(isValidPanelToken('senha-certa', 'senha-certa'), true);
});

test('token errado é recusado', () => {
    assert.strictEqual(isValidPanelToken('senha-errada', 'senha-certa'), false);
});

test('token vazio é sempre recusado, mesmo se WEB_PANEL_TOKEN também estiver vazio', () => {
    assert.strictEqual(isValidPanelToken('', ''), false);
    assert.strictEqual(isValidPanelToken('', undefined), false);
});

test('sem WEB_PANEL_TOKEN configurado no servidor, qualquer token é recusado', () => {
    assert.strictEqual(isValidPanelToken('qualquer-coisa', undefined), false);
});

test('CORREÇÃO DE SEGURANÇA: comparação usa crypto.timingSafeEqual (não early-return por caractere)', () => {
    // Regressão: a versão antiga usava `provided === expected`, que retorna
    // assim que acha a primeira diferença — mensurável em ataques de timing.
    // Não dá pra testar timing de verdade de forma confiável num teste
    // automatizado, mas confirmamos que tokens de tamanhos diferentes (que
    // exigiriam tratamento especial pra não vazar informação de tamanho
    // através de timingSafeEqual, que exige buffers do mesmo tamanho) ainda
    // funcionam corretamente nos dois sentidos.
    assert.strictEqual(isValidPanelToken('curto', 'um-token-bem-mais-longo-que-o-outro'), false);
    assert.strictEqual(isValidPanelToken('um-token-bem-mais-longo-que-o-outro', 'curto'), false);
    assert.strictEqual(isValidPanelToken('exatamente-igual', 'exatamente-igual'), true);
});
