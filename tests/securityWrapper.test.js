const test = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileAsync = promisify(execFile);
const wrapperPath = path.join(__dirname, '..', 'src', 'utils', 'security_wrapper.js');

// Testa security_wrapper.js do jeito que ele é usado de verdade: injetado via
// --require num processo node separado, exatamente como processManager.js
// faz pra todo bot hospedado (caminho de produção atual, já que
// USE_CONTAINERS=false por padrão). Cada teste sobe um processo node real
// com um script malicioso pequeno e confere que o ataque foi bloqueado.

function runInSandbox(botDir, script) {
    const scriptPath = path.join(botDir, '__attack.js');
    fs.writeFileSync(scriptPath, script);
    return execFileAsync(process.execPath, ['--require', wrapperPath, scriptPath], {
        cwd: botDir,
        timeout: 8000,
    }).catch((err) => ({ stdout: err.stdout || '', stderr: err.stderr || '', failed: true }));
}

function makeBotDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-secwrap-test-'));
}

test('require("child_process") é bloqueado', async () => {
    const dir = makeBotDir();
    const { stdout } = await runInSandbox(dir, `
        try { require('child_process'); console.log('VULNERAVEL'); }
        catch (e) { console.log('BLOQUEADO'); }
    `);
    assert.ok(stdout.includes('BLOQUEADO'));
    assert.ok(!stdout.includes('VULNERAVEL'));
});

test('require("node:child_process") (variante prefixada) é bloqueado', async () => {
    const dir = makeBotDir();
    const { stdout } = await runInSandbox(dir, `
        try { require('node:child_process'); console.log('VULNERAVEL'); }
        catch (e) { console.log('BLOQUEADO'); }
    `);
    assert.ok(stdout.includes('BLOQUEADO'));
    assert.ok(!stdout.includes('VULNERAVEL'));
});

test('import() dinâmico de child_process é bloqueado (bypass conhecido do require hook)', async () => {
    const dir = makeBotDir();
    const { stdout } = await runInSandbox(dir, `
        import('node:child_process').then(() => console.log('VULNERAVEL')).catch(() => console.log('BLOQUEADO'));
    `);
    assert.ok(stdout.includes('BLOQUEADO'));
    assert.ok(!stdout.includes('VULNERAVEL'));
});

test('leitura de arquivo fora da pasta do bot (ex: /etc/hostname) é bloqueada', async () => {
    const dir = makeBotDir();
    const { stdout } = await runInSandbox(dir, `
        const fs = require('fs');
        try { fs.readFileSync('/etc/hostname'); console.log('VULNERAVEL'); }
        catch (e) { console.log('BLOQUEADO'); }
    `);
    assert.ok(stdout.includes('BLOQUEADO'));
    assert.ok(!stdout.includes('VULNERAVEL'));
});

test('CRÍTICO: leitura do .env do host (secrets reais da plataforma) é bloqueada', async () => {
    const dir = makeBotDir();
    // Simula um .env "do host" num caminho fora da pasta do bot, com um
    // marcador que NÃO pode aparecer na saída do processo se a blindagem
    // funcionar.
    const fakeEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-fake-host-'));
    fs.writeFileSync(path.join(fakeEnvDir, '.env'), 'BOT_TOKEN=segredo-real-nao-pode-vazar');
    const { stdout } = await runInSandbox(dir, `
        const fs = require('fs');
        try {
            const content = fs.readFileSync(${JSON.stringify(path.join(fakeEnvDir, '.env'))}, 'utf8');
            console.log('VULNERAVEL:' + content);
        } catch (e) { console.log('BLOQUEADO'); }
    `);
    assert.ok(!stdout.includes('segredo-real-nao-pode-vazar'), 'o conteúdo do .env do host jamais pode vazar pro bot hospedado');
    assert.ok(stdout.includes('BLOQUEADO'));
});

test('process.fork() é bloqueado', async () => {
    const dir = makeBotDir();
    const { stdout } = await runInSandbox(dir, `
        try { process.fork(); console.log('VULNERAVEL'); }
        catch (e) { console.log('BLOQUEADO'); }
    `);
    assert.ok(stdout.includes('BLOQUEADO'));
});

test('process.binding("spawn_sync") é bloqueado', async () => {
    const dir = makeBotDir();
    const { stdout } = await runInSandbox(dir, `
        try { process.binding('spawn_sync'); console.log('VULNERAVEL'); }
        catch (e) { console.log('BLOQUEADO'); }
    `);
    assert.ok(stdout.includes('BLOQUEADO'));
});

test('leitura/escrita normal DENTRO da pasta do bot continua funcionando (a blindagem não quebra uso legítimo)', async () => {
    const dir = makeBotDir();
    const { stdout } = await runInSandbox(dir, `
        const fs = require('fs');
        fs.writeFileSync('meu-arquivo.txt', 'ola');
        console.log('CONTEUDO:' + fs.readFileSync('meu-arquivo.txt', 'utf8'));
    `);
    assert.ok(stdout.includes('CONTEUDO:ola'));
});

test('escape via link simbólico plantado dentro da pasta do bot é bloqueado', async () => {
    const dir = makeBotDir();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlantic-secwrap-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'nao-pode-vazar-via-symlink');
    const { stdout } = await runInSandbox(dir, `
        const fs = require('fs');
        const path = require('path');
        fs.symlinkSync(${JSON.stringify(outsideDir)}, path.join(process.cwd(), 'escape'));
        try {
            const content = fs.readFileSync(path.join(process.cwd(), 'escape', 'secret.txt'), 'utf8');
            console.log('VULNERAVEL:' + content);
        } catch (e) { console.log('BLOQUEADO'); }
    `);
    assert.ok(!stdout.includes('nao-pode-vazar-via-symlink'));
    assert.ok(stdout.includes('BLOQUEADO'));
});
