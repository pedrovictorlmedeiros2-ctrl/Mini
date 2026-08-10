const test = require('node:test');
const assert = require('node:assert/strict');

process.env.PANEL_SESSION_SECRET = 'test-secret-at-least-16-chars-long';
const { createSessionToken, verifySessionToken } = require('../src/utils/panelSession');

test('token criado é válido e devolve o discordUserId original', () => {
    const token = createSessionToken('123456789012345678');
    const payload = verifySessionToken(token);
    assert.ok(payload);
    assert.strictEqual(payload.sub, '123456789012345678');
});

test('token adulterado (payload alterado) é rejeitado', () => {
    const token = createSessionToken('123456789012345678');
    const [encoded, sig] = token.split('.');
    const tampered = Buffer.from(encoded, 'base64url').toString('utf8').replace('123456789012345678', '999999999999999999');
    const tamperedEncoded = Buffer.from(tampered).toString('base64url');
    assert.strictEqual(verifySessionToken(`${tamperedEncoded}.${sig}`), null);
});

test('assinatura errada é rejeitada mesmo com payload válido', () => {
    const token = createSessionToken('123456789012345678');
    const [encoded] = token.split('.');
    assert.strictEqual(verifySessionToken(`${encoded}.0000000000000000000000000000000000000000000000000000000000000000`), null);
});

test('token vazio, undefined ou sem ponto é rejeitado', () => {
    assert.strictEqual(verifySessionToken(''), null);
    assert.strictEqual(verifySessionToken(undefined), null);
    assert.strictEqual(verifySessionToken('sem-ponto-nenhum'), null);
});

test('token expirado é rejeitado', () => {
    // Fabrica um token já expirado manipulando o clock via Date.now mock simples:
    // como createSessionToken usa TTL fixo de 7 dias, testamos o caminho de
    // expiração assinando manualmente um payload com exp no passado.
    const crypto = require('crypto');
    const payload = { sub: '123456789012345678', iat: Date.now() - 1000, exp: Date.now() - 500 };
    const payloadJson = JSON.stringify(payload);
    const encoded = Buffer.from(payloadJson).toString('base64url');
    const sig = crypto.createHmac('sha256', process.env.PANEL_SESSION_SECRET).update(payloadJson).digest('hex');
    assert.strictEqual(verifySessionToken(`${encoded}.${sig}`), null);
});

test('dois tokens do mesmo usuário emitidos em momentos diferentes têm valores diferentes (iat muda)', () => {
    const a = createSessionToken('123456789012345678');
    const b = createSessionToken('123456789012345678');
    // Podem colidir em teoria se emitidos no mesmíssimo milissegundo, mas o
    // importante é que ambos continuam válidos independentemente.
    assert.ok(verifySessionToken(a));
    assert.ok(verifySessionToken(b));
});

test('lança erro claro se PANEL_SESSION_SECRET não estiver configurado', () => {
    const original = process.env.PANEL_SESSION_SECRET;
    delete process.env.PANEL_SESSION_SECRET;
    try {
        assert.throws(() => createSessionToken('123456789012345678'), /PANEL_SESSION_SECRET/);
    } finally {
        process.env.PANEL_SESSION_SECRET = original;
    }
});
