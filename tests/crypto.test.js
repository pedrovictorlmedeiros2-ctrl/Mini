const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';
const { encrypt, decrypt } = require('../src/utils/crypto');

test('encrypt/decrypt round-trip preserves the original value', () => {
    const plain = 'discord-token-example';
    const encrypted = encrypt(plain);

    assert.ok(encrypted);
    assert.match(encrypted, /^v2:/);
    assert.notStrictEqual(encrypted, plain);
    assert.strictEqual(decrypt(encrypted), plain);
});
