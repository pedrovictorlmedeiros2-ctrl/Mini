const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { addLocalFolderSafe } = require('../src/utils/safeZipFolder');

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('CORREÇÃO DE SEGURANÇA CRÍTICA (achado C5): symlink plantado na pasta do bot não vaza o alvo no backup', () => {
    // Regressão do achado real: zip.addLocalFolder() usa fs.statSync (segue
    // symlink) pra decidir se desce num diretório. Um bot plantando um link
    // simbólico dentro da própria pasta apontando pra fora conseguia exfiltrar
    // qualquer arquivo legível pelo processo do Atlantic Host via um Backup normal.
    const botDir = makeTempDir('atlantic-backup-test-bot-');
    const hostSecretDir = makeTempDir('atlantic-backup-test-host-');
    fs.writeFileSync(path.join(botDir, 'index.js'), 'console.log(1)');
    fs.writeFileSync(path.join(hostSecretDir, '.env'), 'SEGREDO_DA_PLATAFORMA=nao-pode-vazar-no-backup');
    fs.symlinkSync(hostSecretDir, path.join(botDir, 'leak_secret'));

    const zip = new AdmZip();
    const skipped = [];
    addLocalFolderSafe(zip, botDir, { onSkippedSymlink: (rel) => skipped.push(rel) });

    const entryNames = zip.getEntries().map((e) => e.entryName);
    assert.ok(entryNames.includes('index.js'), 'arquivo legítimo do bot deve continuar no backup');
    assert.ok(
        !entryNames.some((name) => name.includes('leak_secret')),
        `nenhuma entrada do symlink ou do seu alvo deveria aparecer no zip, veio: ${entryNames}`
    );
    assert.ok(
        !zip.getEntries().some((e) => e.getData().toString().includes('SEGREDO_DA_PLATAFORMA')),
        'o conteúdo do .env do host nunca deve aparecer em nenhuma entrada do zip'
    );
    assert.deepEqual(skipped, ['leak_secret'], 'o symlink deveria ser reportado como pulado, não silenciosamente ignorado sem log');

    fs.rmSync(botDir, { recursive: true, force: true });
    fs.rmSync(hostSecretDir, { recursive: true, force: true });
});

test('symlink apontando pra um arquivo (não diretório) também é pulado, não só symlink-pra-diretório', () => {
    const botDir = makeTempDir('atlantic-backup-test-bot2-');
    const hostSecretFile = path.join(makeTempDir('atlantic-backup-test-host2-'), 'segredo.txt');
    fs.writeFileSync(hostSecretFile, 'outro segredo que nao pode vazar');
    fs.symlinkSync(hostSecretFile, path.join(botDir, 'link_arquivo'));

    const zip = new AdmZip();
    addLocalFolderSafe(zip, botDir);

    assert.equal(zip.getEntries().length, 0, 'só havia um symlink na pasta — o zip deve sair vazio, sem seguir o link');

    fs.rmSync(botDir, { recursive: true, force: true });
});

test('symlink apontando pra dentro de subpasta profunda continua bloqueado (não é só o caso raso)', () => {
    const botDir = makeTempDir('atlantic-backup-test-bot3-');
    const hostSecretDir = makeTempDir('atlantic-backup-test-host3-');
    fs.writeFileSync(path.join(hostSecretDir, '.env'), 'SEGREDO_PROFUNDO=nao-pode-vazar');
    fs.mkdirSync(path.join(botDir, 'a', 'b', 'c'), { recursive: true });
    fs.symlinkSync(hostSecretDir, path.join(botDir, 'a', 'b', 'c', 'leak'));

    const zip = new AdmZip();
    addLocalFolderSafe(zip, botDir);

    const entryNames = zip.getEntries().map((e) => e.entryName);
    assert.ok(!entryNames.some((n) => n.includes('leak')), `link profundo não deveria aparecer, veio: ${entryNames}`);
    assert.ok(
        !zip.getEntries().some((e) => e.getData().toString().includes('SEGREDO_PROFUNDO')),
        'segredo não pode vazar mesmo com o link várias pastas abaixo da raiz do backup'
    );

    fs.rmSync(botDir, { recursive: true, force: true });
    fs.rmSync(hostSecretDir, { recursive: true, force: true });
});

test('estrutura legítima (arquivos + subpastas + pasta vazia) continua sendo empacotada corretamente', () => {
    const botDir = makeTempDir('atlantic-backup-test-legit-');
    fs.writeFileSync(path.join(botDir, 'index.js'), 'console.log("ok")');
    fs.mkdirSync(path.join(botDir, 'src'));
    fs.writeFileSync(path.join(botDir, 'src', 'util.js'), 'module.exports = {}');
    fs.mkdirSync(path.join(botDir, 'pasta-vazia'));

    const zip = new AdmZip();
    addLocalFolderSafe(zip, botDir);

    const entryNames = zip.getEntries().map((e) => e.entryName);
    assert.ok(entryNames.includes('index.js'));
    assert.ok(entryNames.includes('src/util.js'));
    assert.ok(entryNames.includes('pasta-vazia/'), 'pasta vazia legítima ainda deve virar uma entrada no zip (paridade com addLocalFolder)');
    assert.equal(
        zip.readAsText('src/util.js'),
        'module.exports = {}',
        'conteúdo de arquivo legítimo deve ser preservado sem alteração'
    );

    fs.rmSync(botDir, { recursive: true, force: true });
});

test('regressão de integração: backupManager.createBackup() usa addLocalFolderSafe, não zip.addLocalFolder (vulnerável)', () => {
    // Não reexecuta a criação completa do backup (exige banco de dados) —
    // mas garante que ninguém reintroduza a chamada vulnerável por engano
    // numa refatoração futura, checando o código-fonte real do módulo.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'managers', 'backupManager.js'), 'utf8');
    const codeLines = source.split('\n').filter((line) => !line.trim().startsWith('//'));
    const codeOnly = codeLines.join('\n');
    assert.ok(
        codeOnly.includes('addLocalFolderSafe(zip'),
        'createBackup() deveria usar addLocalFolderSafe (imune a symlink)'
    );
    assert.ok(
        !/\bzip\.addLocalFolder\(/.test(codeOnly),
        'zip.addLocalFolder() (vulnerável ao achado C5 — segue symlink) não deveria mais ser chamado em código ativo de backupManager.js'
    );
});
