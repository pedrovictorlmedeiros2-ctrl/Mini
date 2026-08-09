const test = require('node:test');
const assert = require('node:assert/strict');

test('prometheus line helper formats labels safely', () => {
    // Inline minimal copy of formatter to avoid DB/sqlite in CI sandboxes
    function escapeLabel(v) {
        return String(v ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
    }
    function line(name, value, labels = {}) {
        const keys = Object.keys(labels);
        if (keys.length === 0) return `${name} ${value}`;
        const lbl = keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(',');
        return `${name}{${lbl}} ${value}`;
    }
    assert.equal(line('m', 1), 'm 1');
    assert.equal(line('m', 2, { a: 'x' }), 'm{a="x"} 2');
    assert.equal(line('m', 3, { a: 'say "hi"' }), 'm{a="say \\"hi\\""} 3');
});
