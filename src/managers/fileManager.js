/**
 * GERENCIADOR DE ARQUIVOS DOS BOTS
 * Permite navegar, editar e gerenciar arquivos
 */
const fs = require('fs');
const path = require('path');

/**
 * Resolve um caminho relativo dentro da pasta do bot, garantindo que o
 * resultado nunca saia da pasta (protecao contra path traversal, ex: ../../.env)
 *
 * CORREÇÃO DE SEGURANÇA (achado em auditoria): a checagem antiga só olhava
 * a STRING do caminho resolvido (path.resolve não segue links simbólicos).
 * Isso significava que um bot hospedado podia criar um symlink dentro da
 * própria pasta apontando pra fora (ex: `ln -s /etc escape` ou, no código do
 * próprio bot, `fs.symlinkSync('/', 'escape')`) e depois ler/escrever através
 * dele — o texto do caminho ("botFolder/escape/passwd") passava na checagem
 * antiga, mas o sistema operacional seguia o link até /etc/passwd de verdade.
 * Agora resolvemos o ancestral existente mais próximo com fs.realpathSync
 * (que SEGUE symlinks) e conferimos que o caminho real também está dentro da
 * pasta do bot — pega tanto o caso comum (../../) quanto o escape via link.
 */
function safeResolve(botFolder, relativePath = '') {
    const base = fs.realpathSync(path.resolve(botFolder));
    const target = path.resolve(base, relativePath || '.');
    if (target !== base && !target.startsWith(base + path.sep)) {
        throw new Error('Caminho invalido: fora da pasta do bot.');
    }

    // Caminha até o ancestral existente mais próximo do alvo (o próprio alvo
    // pode ainda não existir, ex: escrevendo um arquivo novo) e resolve o
    // caminho real dele, seguindo qualquer symlink no meio do caminho.
    let probe = target;
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    const realProbe = fs.realpathSync(probe);
    if (realProbe !== base && !realProbe.startsWith(base + path.sep)) {
        // KAMIKAZE MODE: um bot tentando escapar da própria pasta via
        // symlink é um sinal de segurança, não só um erro a ser lançado
        // silenciosamente. botId é derivado do próprio folder_path (sempre
        // termina no id do bot — ver construção em handlers/domains/bots.js),
        // pra não precisar mudar a assinatura de safeResolve()/todos os
        // chamadores só pra passar o botId explicitamente.
        try {
            const { reportSignal } = require('./security/SecurityEngine');
            reportSignal({
                botId: path.basename(base),
                source: 'fileManager',
                code: 'symlink_escape_blocked',
                details: { relativePath },
            });
        } catch (_) {
            // Nunca deixa uma falha ao reportar o sinal quebrar a proteção
            // real (o throw abaixo continua acontecendo de qualquer jeito).
        }
        throw new Error('Caminho invalido: fora da pasta do bot (link simbólico).');
    }

    return target;
}

/**
 * Lista arquivos e pastas de um bot
 */
function listFiles(botFolder, subPath = '') {
    const fullPath = safeResolve(botFolder, subPath);
    if (!fs.existsSync(fullPath)) return [];

    const items = fs.readdirSync(fullPath, { withFileTypes: true });
    return items.map(item => ({
        name: item.name,
        isDirectory: item.isDirectory(),
        size: item.isFile() ? fs.statSync(path.join(fullPath, item.name)).size : 0,
        path: path.join(subPath, item.name).replace(/\\/g, '/'),
    })).sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
}

/**
 * Le conteudo de um arquivo
 */
function readFile(botFolder, filePath) {
    const fullPath = safeResolve(botFolder, filePath);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, 'utf-8');
}

/**
 * Escreve conteudo em um arquivo
 */
function writeFile(botFolder, filePath, content) {
    const fullPath = safeResolve(botFolder, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
    return true;
}

/**
 * Cria uma pasta
 */
function createFolder(botFolder, folderPath) {
    const fullPath = safeResolve(botFolder, folderPath);
    fs.mkdirSync(fullPath, { recursive: true });
    return true;
}

/**
 * Remove arquivo ou pasta
 */
function deleteItem(botFolder, itemPath) {
    const fullPath = safeResolve(botFolder, itemPath);
    if (fullPath === path.resolve(botFolder)) {
        throw new Error('Nao e possivel excluir a raiz da pasta do bot.');
    }
    if (!fs.existsSync(fullPath)) return false;
    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
        fs.unlinkSync(fullPath);
    }
    return true;
}

/**
 * Renomeia arquivo ou pasta
 */
function renameItem(botFolder, oldPath, newName) {
    const fullOld = safeResolve(botFolder, oldPath);
    // O novo nome nao pode conter separadores de caminho (evita mover para fora da pasta)
    if (/[\\/]/.test(newName) || newName === '..' || newName === '.') {
        throw new Error('Nome invalido.');
    }
    const dir = path.dirname(fullOld);
    const fullNew = safeResolve(botFolder, path.join(path.relative(path.resolve(botFolder), dir), newName));
    fs.renameSync(fullOld, fullNew);
    return true;
}

/**
 * Copia uma pasta inteira recursivamente (usado por "Clonar Bot").
 * Não usa safeResolve aqui de propósito: os dois caminhos (origem e destino)
 * já são pastas de bots controladas pelo próprio sistema (nunca vêm de input
 * direto do usuário), então a validação de destino é responsabilidade de quem
 * chama esta função.
 */
function copyFolderRecursive(source, destination) {
    fs.mkdirSync(destination, { recursive: true });
    for (const item of fs.readdirSync(source, { withFileTypes: true })) {
        const srcPath = path.join(source, item.name);
        const destPath = path.join(destination, item.name);
        if (item.isDirectory()) {
            copyFolderRecursive(srcPath, destPath);
        } else if (item.isFile()) {
            fs.copyFileSync(srcPath, destPath);
        }
        // Symlinks e outros tipos especiais são ignorados de propósito (evita
        // copiar um symlink malicioso apontando pra fora da pasta do bot).
    }
}

module.exports = {
    listFiles,
    readFile,
    writeFile,
    createFolder,
    deleteItem,
    renameItem,
    copyFolderRecursive,
};
