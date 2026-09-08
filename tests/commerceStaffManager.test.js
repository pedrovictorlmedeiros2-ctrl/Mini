const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

process.env.ENCRYPTION_KEY = 'test-encryption-key-123456';

const dbFile = path.join(__dirname, '..', 'src', 'database', 'test-commerceStaffManager.db');
if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
process.env.HOSTING_DB_PATH = dbFile;

const { initDatabase, run, get } = require('../src/database/database');
initDatabase();

const CommerceStaffManager = require('../src/managers/commerce/CommerceStaffManager');

let counter = 0;
function makeUser(role = 'client') {
    counter += 1;
    const userId = `csmtest-${counter}`;
    run("INSERT INTO users (id, username, role) VALUES (?, ?, ?)", [userId, 'tester', role]);
    return userId;
}

test('grant: só admin pode conceder COMMERCE_STAFF', () => {
    const admin = makeUser('admin');
    const target = makeUser('client');
    const granted = CommerceStaffManager.grant(target, admin);
    assert.equal(granted.user_id, target);
    assert.equal(granted.revoked_at, null);
});

test('grant: client/moderator não podem conceder — nem pra si mesmo, nem pra terceiros', () => {
    const client = makeUser('client');
    const moderator = makeUser('moderator');
    const target = makeUser('client');
    assert.throws(() => CommerceStaffManager.grant(target, client), /Só administradores/);
    assert.throws(() => CommerceStaffManager.grant(client, client), /Só administradores/);
    assert.throws(() => CommerceStaffManager.grant(target, moderator), /Só administradores/);
});

test('isActiveCommerceStaff: false antes de conceder, true depois', () => {
    const admin = makeUser('admin');
    const target = makeUser('client');
    assert.equal(CommerceStaffManager.isActiveCommerceStaff(target), false);
    CommerceStaffManager.grant(target, admin);
    assert.equal(CommerceStaffManager.isActiveCommerceStaff(target), true);
});

test('revoke: só admin pode revogar; some depois de revogado (soft-revoke, linha permanece)', () => {
    const admin = makeUser('admin');
    const target = makeUser('client');
    CommerceStaffManager.grant(target, admin);

    const client = makeUser('client');
    assert.throws(() => CommerceStaffManager.revoke(target, client), /Só administradores/);

    CommerceStaffManager.revoke(target, admin);
    assert.equal(CommerceStaffManager.isActiveCommerceStaff(target), false);

    const row = get('SELECT * FROM commerce_staff WHERE user_id = ?', [target]);
    assert.ok(row, 'a linha nunca deveria ser apagada (soft-revoke)');
    assert.ok(row.revoked_at);
    assert.equal(row.revoked_by, admin);
});

test('grant após revoke: reativa (limpa revoked_at/revoked_by)', () => {
    const admin = makeUser('admin');
    const target = makeUser('client');
    CommerceStaffManager.grant(target, admin);
    CommerceStaffManager.revoke(target, admin);
    assert.equal(CommerceStaffManager.isActiveCommerceStaff(target), false);

    CommerceStaffManager.grant(target, admin);
    assert.equal(CommerceStaffManager.isActiveCommerceStaff(target), true);
    const row = get('SELECT * FROM commerce_staff WHERE user_id = ?', [target]);
    assert.equal(row.revoked_at, null);
});

test('grant: idempotente — chamar duas vezes pra quem já está ativo não duplica nem lança', () => {
    const admin = makeUser('admin');
    const target = makeUser('client');
    CommerceStaffManager.grant(target, admin);
    assert.doesNotThrow(() => CommerceStaffManager.grant(target, admin));
    assert.equal(CommerceStaffManager.isActiveCommerceStaff(target), true);
});

test('hasCommercePermission: admin sempre true, mesmo sem grant explícito', () => {
    const admin = makeUser('admin');
    assert.equal(CommerceStaffManager.hasCommercePermission(admin), true);
});

test('hasCommercePermission: COMMERCE_STAFF true, client comum false', () => {
    const admin = makeUser('admin');
    const staff = makeUser('client');
    const client = makeUser('client');
    CommerceStaffManager.grant(staff, admin);

    assert.equal(CommerceStaffManager.hasCommercePermission(staff), true);
    assert.equal(CommerceStaffManager.hasCommercePermission(client), false);
});

test('hasCommercePermission: MODERATOR NÃO herda automaticamente — decisão explícita, COMMERCE_STAFF é alternativa a Administrator, não ampliação pra moderator', () => {
    const moderator = makeUser('moderator');
    assert.equal(CommerceStaffManager.hasCommercePermission(moderator), false);
});

test('hasCommercePermission: false depois de revogado', () => {
    const admin = makeUser('admin');
    const target = makeUser('client');
    CommerceStaffManager.grant(target, admin);
    CommerceStaffManager.revoke(target, admin);
    assert.equal(CommerceStaffManager.hasCommercePermission(target), false);
});
