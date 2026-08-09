const test = require('node:test');
const assert = require('node:assert/strict');
const { recordAuditEvent, getRecentAuditEvents } = require('../src/managers/auditManager');

test('recordAuditEvent stores an audit entry that can be retrieved later', () => {
    const eventName = `audit-test-${Date.now()}`;
    recordAuditEvent({
        userId: 'audit-user',
        event: eventName,
        details: 'teste de auditoria',
        severity: 'info',
    });

    const entries = getRecentAuditEvents(20);
    const match = entries.find(entry => entry.action === eventName && entry.details === 'teste de auditoria');

    assert.ok(match, 'expected the audit event to be persisted and retrievable');
});
