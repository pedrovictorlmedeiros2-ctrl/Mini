/**
 * EMPACOTAMENTO SEGURO DE PASTA EM ZIP — extraído pra ser testável
 * isoladamente (ver tests/safeZipFolder.test.js).
 *
 * Corrige o achado C5 do SECURITY_AUDIT.md: `AdmZip.addLocalFolder()` decide
 * se desce recursivamente num diretório usando `fs.statSync`, que SEGUE
 * link simbólico. Um bot hospedado plantando
 * `fs.symlinkSync('/qualquer/caminho/legível/pelo/host', 'pasta_inocente')`
 * dentro da própria pasta faz o backup (feature normal, disparada pelo
 * próprio cliente) incluir o conteúdo do alvo do link no zip — exfiltrando
 * qualquer arquivo legível pelo processo do Atlantic Host, incluindo o
 * `.env` real da plataforma.
 *
 * `addLocalFolderSafe` caminha a árvore com `fs.lstatSync` (que NÃO segue
 * link simbólico) e pula qualquer entrada que seja um link — nunca lê nem
 * inclui o alvo, então não importa pra onde o link aponte.
 */
const fs = require('fs');
const path = require('path');

/**
 * Adiciona o conteúdo de sourcePath a um AdmZip, ignorando links simbólicos
 * (nunca segue, nunca inclui o alvo — só arquivos e diretórios reais).
 *
 * @param {import('adm-zip')} zip - instância do AdmZip a preencher
 * @param {string} sourcePath - pasta raiz a empacotar
 * @param {{onSkippedSymlink?: (relPath: string) => void}} [options]
 */
function addLocalFolderSafe(zip, sourcePath, options = {}) {
    const rootReal = fs.realpathSync(sourcePath);

    function walk(currentDir, relPrefix) {
        const dirents = fs.readdirSync(currentDir, { withFileTypes: true });

        if (dirents.length === 0 && relPrefix) {
            // Preserva o comportamento do addLocalFolder original: diretórios
            // vazios ainda viram uma entrada no zip (só não têm conteúdo).
            zip.addFile(relPrefix + '/', Buffer.alloc(0));
            return;
        }

        for (const dirent of dirents) {
            const abs = path.join(currentDir, dirent.name);
            const rel = relPrefix ? `${relPrefix}/${dirent.name}` : dirent.name;

            // lstatSync (NÃO segue symlink) é a checagem certa aqui — é
            // exatamente o oposto do que o adm-zip usa internamente, e é
            // essa diferença que fecha o vazamento do achado C5.
            let st;
            try {
                st = fs.lstatSync(abs);
            } catch {
                continue; // sumiu entre o readdir e o lstat; ignora
            }

            if (st.isSymbolicLink()) {
                if (options.onSkippedSymlink) options.onSkippedSymlink(rel);
                continue; // nunca resolve o alvo — é isso que impede a exfiltração
            }

            if (st.isDirectory()) {
                walk(abs, rel);
            } else if (st.isFile()) {
                zip.addFile(rel, fs.readFileSync(abs));
            }
            // outros tipos (socket, fifo, device) são ignorados de propósito
        }
    }

    walk(rootReal, '');
}

module.exports = { addLocalFolderSafe };
