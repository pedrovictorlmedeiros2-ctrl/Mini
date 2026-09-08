const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { acquireInstanceLock, releaseInstanceLock, lockPathFor, isPidAlive } = require('../src/utils/instanceLock');

function tempDbPath() {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-lock-test-')), 'hosting.db');
}

test('acquireInstanceLock() cria o arquivo de lock com PID/hostname/timestamp', () => {
    const dbPath = tempDbPath();
    const lockPath = acquireInstanceLock(dbPath);

    assert.equal(lockPath, lockPathFor(dbPath));
    assert.ok(fs.existsSync(lockPath));
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(info.pid, process.pid);
    assert.ok(info.hostname);
    assert.ok(info.startedAt);

    releaseInstanceLock(dbPath);
});

test('segunda tentativa de adquirir o MESMO banco enquanto a primeira instância está "viva" (nosso próprio PID) é recusada', () => {
    const dbPath = tempDbPath();
    acquireInstanceLock(dbPath);

    assert.throws(
        () => acquireInstanceLock(dbPath),
        /já existe uma instância/i
    );

    releaseInstanceLock(dbPath);
});

test('releaseInstanceLock() libera o lock — uma nova instância consegue adquirir depois', () => {
    const dbPath = tempDbPath();
    acquireInstanceLock(dbPath);
    releaseInstanceLock(dbPath);

    assert.equal(fs.existsSync(lockPathFor(dbPath)), false);
    assert.doesNotThrow(() => acquireInstanceLock(dbPath));

    releaseInstanceLock(dbPath);
});

test('AUTO-CURA: lock órfão (PID que não existe mais) é detectado e removido, nunca trava um boot legítimo', () => {
    const dbPath = tempDbPath();
    const lockPath = lockPathFor(dbPath);

    // PID quase certamente livre: escolhe um número alto e confirma que
    // está morto antes de prosseguir (evita flakiness num PID real por acaso).
    const deadPid = 999999;
    assert.equal(isPidAlive(deadPid), false, 'pré-condição do teste: este PID precisa estar morto');

    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, hostname: 'host-fantasma', startedAt: 'ontem' }));

    assert.doesNotThrow(() => acquireInstanceLock(dbPath));
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(info.pid, process.pid, 'o lock deveria ter sido substituído pelo processo atual');

    releaseInstanceLock(dbPath);
});

test('AUTO-CURA: arquivo de lock corrompido (JSON inválido) é tratado como órfão, não trava o boot', () => {
    const dbPath = tempDbPath();
    const lockPath = lockPathFor(dbPath);
    fs.writeFileSync(lockPath, 'isto não é json válido {{{');

    assert.doesNotThrow(() => acquireInstanceLock(dbPath));
    releaseInstanceLock(dbPath);
});

test('releaseInstanceLock() nunca remove um lock que pertence a OUTRO pid (nunca apaga o lock de uma instância mais nova por engano)', () => {
    const dbPath = tempDbPath();
    const lockPath = lockPathFor(dbPath);
    // Simula um lock pertencente a outro processo (vivo ou não, não importa
    // aqui — o que importa é que o PID não é o nosso).
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, hostname: 'outro-host', startedAt: 'agora' }));

    releaseInstanceLock(dbPath);

    assert.ok(fs.existsSync(lockPath), 'o lock de outro PID não deveria ter sido removido');
    fs.unlinkSync(lockPath); // limpeza manual do teste
});

test('ISOLAMENTO: bancos diferentes nunca disputam o mesmo lock (dbPath compõe o caminho do arquivo)', () => {
    const dbPathA = tempDbPath();
    const dbPathB = tempDbPath();

    assert.doesNotThrow(() => acquireInstanceLock(dbPathA));
    assert.doesNotThrow(() => acquireInstanceLock(dbPathB), 'um banco diferente nunca deveria ser bloqueado pelo lock de outro banco');

    releaseInstanceLock(dbPathA);
    releaseInstanceLock(dbPathB);
});
