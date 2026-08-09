/**
 * VALIDAÇÃO DE ZIP — extraído de interactionHandler.js pra ser testável
 * isoladamente (ver tests/zipValidation.test.js).
 *
 * Duas proteções:
 * - zip-slip: recusa entradas cujo caminho escaparia da pasta de destino
 *   (ex: "../../etc/passwd" dentro do zip)
 * - zip bomb: recusa zips com arquivos demais ou que expandem demais quando
 *   descompactados (o limite de MB do upload só vale pro .zip comprimido)
 */
const path = require('path');

/**
 * Valida as entradas de um zip (já aberto via AdmZip) contra zip-slip e
 * zip bomb, ANTES de qualquer extração acontecer.
 *
 * @param {Array<{entryName: string, header: {size: number}}>} entries - zip.getEntries()
 * @param {string} destFolder - pasta de destino da extração
 * @param {{maxEntries?: number, maxUnzippedSizeMB?: number}} limits
 * @throws {Error} com mensagem explicando qual proteção barrou
 */
function validateZipEntries(entries, destFolder, limits = {}) {
    const maxEntries = limits.maxEntries ?? 2000;
    const maxUnzippedBytes = (limits.maxUnzippedSizeMB ?? 300) * 1024 * 1024;
    const destRoot = path.resolve(destFolder);

    if (entries.length > maxEntries) {
        throw new Error(`ZIP contém arquivos demais (${entries.length}, máximo ${maxEntries}).`);
    }

    let totalUncompressed = 0;
    for (const entry of entries) {
        totalUncompressed += entry.header.size;
        if (totalUncompressed > maxUnzippedBytes) {
            throw new Error(`ZIP expande para mais de ${limits.maxUnzippedSizeMB ?? 300}MB descompactado — recusado.`);
        }
    }

    for (const entry of entries) {
        // CORREÇÃO DE SEGURANÇA CRÍTICA: um zip malicioso pode usar '\' no nome
        // da entrada (o formato zip padrão usa só '/', mas nada IMPEDE um zip
        // malformado/malicioso de conter '\'). No Windows — onde o Atlantic
        // Host roda de verdade — path.resolve() trata '\' como separador real
        // de pasta, então "..\\..\\..\\.env" ESCAPA da pasta do bot e alcança
        // o .env do próprio host. path.resolve() no host Linux de teste não
        // pega isso (lá '\' é só um caractere normal), então essa checagem
        // tem que ser explícita e não pode depender do path.resolve do SO atual.
        if (entry.entryName.includes('\\')) {
            throw new Error('ZIP contém caminhos inválidos (possível zip-slip via barra invertida).');
        }
        const entryDest = path.resolve(destRoot, entry.entryName);
        if (entryDest !== destRoot && !entryDest.startsWith(destRoot + path.sep)) {
            throw new Error('ZIP contém caminhos inválidos (possível zip-slip).');
        }
    }
}

module.exports = { validateZipEntries };
