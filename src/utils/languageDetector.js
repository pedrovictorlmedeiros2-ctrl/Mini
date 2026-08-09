/**
 * DETECTOR DE LINGUAGEM E ARQUIVO PRINCIPAL
 * Compartilhado entre o deploy via ZIP e o deploy via GitHub, para não
 * duplicar (e arriscar divergir) a mesma lógica em dois lugares.
 */
const fs = require('fs');
const path = require('path');

const JS_CANDIDATES = ['index.js', 'main.js', 'bot.js', 'app.js'];
const PYTHON_CANDIDATES = ['main.py', 'bot.py', 'app.py'];

/**
 * Procura o arquivo principal na pasta (ou, se o código estiver dentro de
 * uma única subpasta — comum em ZIPs exportados do GitHub —, dentro dela).
 * @returns {{ language: string|null, mainFile: string|null, searchRoot: string }}
 */
function detectLanguageAndMainFile(folderPath) {
    let searchRoot = folderPath;
    const topEntries = fs.readdirSync(folderPath);
    if (topEntries.length === 1 && fs.statSync(path.join(folderPath, topEntries[0])).isDirectory()) {
        searchRoot = path.join(folderPath, topEntries[0]);
    }

    for (const f of JS_CANDIDATES) {
        if (fs.existsSync(path.join(searchRoot, f))) return { language: 'javascript', mainFile: f, searchRoot };
    }
    for (const f of PYTHON_CANDIDATES) {
        if (fs.existsSync(path.join(searchRoot, f))) return { language: 'python', mainFile: f, searchRoot };
    }

    return { language: null, mainFile: null, searchRoot };
}

/**
 * Se o código estava dentro de uma subpasta única (searchRoot !== folderPath),
 * sobe todo o conteúdo de dentro dela para a raiz da pasta do bot.
 */
function flattenSingleSubfolder(folderPath, searchRoot) {
    if (searchRoot === folderPath) return;
    for (const item of fs.readdirSync(searchRoot)) {
        fs.renameSync(path.join(searchRoot, item), path.join(folderPath, item));
    }
    fs.rmSync(searchRoot, { recursive: true, force: true });
}

module.exports = { detectLanguageAndMainFile, flattenSingleSubfolder };
