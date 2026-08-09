const test = require('node:test');
const assert = require('node:assert/strict');

test('failoverEnabled env parsing', () => {
    function failoverEnabled(env) {
        const v = String(env || '').toLowerCase();
        return v === 'true' || v === '1';
    }
    assert.equal(failoverEnabled('true'), true);
    assert.equal(failoverEnabled('1'), true);
    assert.equal(failoverEnabled('false'), false);
    assert.equal(failoverEnabled(''), false);
    assert.equal(failoverEnabled(undefined), false);
});
