/**
 * LOCK DE INSTÂNCIA ÚNICA
 *
 * Impede que duas instâncias do Atlantic Host rodem simultaneamente
 * apontando pro MESMO banco — duas instâncias escrevendo no mesmo SQLite
 * (mesmo com WAL) podem duplicar processos de bot, disputar as mesmas
 * portas (health/webhook/proxy) e corromper o estado de `activeProcesses`
 * (que é só em memória, por processo).
 *
 * O lock é um arquivo (`<caminho-do-banco>.lock`) — atrelado ao banco, não
 * um lock global do sistema, pra bater exatamente com o requisito
 * ("duas instâncias usando o MESMO banco"): dois bancos diferentes (ex:
 * testes, ou uma segunda instalação separada) nunca disputam o mesmo lock.
 *
 * Auto-cura: se o processo dono do lock já morreu (crash, SIGKILL, queda de
 * energia), o lock é tratado como órfão e removido antes de criar um novo —
 * nunca trava uma inicialização legítima por um lock que não corresponde a
 * nenhum processo vivo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function lockPathFor(dbPath) {
    return `${dbPath}.lock`;
}

/**
 * Verifica se um PID ainda está vivo, sem matar nem sinalizar nada de
 * verdade (signal 0 é só uma checagem de existência/permissão).
 */
function isPidAlive(pid) {
    if (!pid || typeof pid !== 'number') return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM: o processo existe, só não temos permissão de sinalizá-lo —
        // ainda está vivo. ESRCH (ou qualquer outro erro): não existe.
        return err.code === 'EPERM';
    }
}

function readLockInfo(lockPath) {
    try {
        return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
        return null; // arquivo ausente, ilegível ou corrompido — tratado como órfão
    }
}

/**
 * Tenta adquirir o lock. Lança um Error com mensagem clara se já houver uma
 * instância viva. Nunca deve ser chamado mais de uma vez sem um
 * releaseInstanceLock() no meio (ex: em testes) — cada chamada cria um
 * arquivo novo via criação exclusiva atômica (flag 'wx'), que também pega a
 * corrida rara de duas instâncias tentando adquirir no mesmíssimo instante.
 *
 * @param {string} dbPath
 * @returns {string} o caminho do lock adquirido
 */
function acquireInstanceLock(dbPath) {
    const lockPath = lockPathFor(dbPath);

    if (fs.existsSync(lockPath)) {
        const info = readLockInfo(lockPath);
        if (info && isPidAlive(info.pid)) {
            throw new Error(
                `Já existe uma instância do Atlantic Host rodando (PID ${info.pid}, host ${info.hostname || '?'}, ` +
                `iniciada em ${info.startedAt || '?'}) usando este banco (${dbPath}). ` +
                `Encerre-a antes de iniciar uma nova (nunca duas instâncias no mesmo banco), ` +
                `ou apague ${lockPath} manualmente se tiver certeza absoluta de que é um lock órfão.`
            );
        }
        // Lock órfão (processo já morreu, ou arquivo corrompido/ilegível) —
        // remove antes de recriar. Isso é o que permite reiniciar depois de
        // um crash/SIGKILL sem intervenção manual.
        try { fs.unlinkSync(lockPath); } catch { /* já pode ter sumido */ }
    }

    const payload = JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        startedAt: new Date().toISOString(),
    });

    let fd;
    try {
        // 'wx': cria e falha se já existir — atômico no nível do SO, fecha
        // a janela de corrida entre duas instâncias checando
        // fs.existsSync() como "livre" ao mesmo tempo.
        fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
        if (err.code === 'EEXIST') {
            throw new Error(
                `Corrida detectada ao adquirir o lock de instância (${lockPath}) — outro processo criou o ` +
                `arquivo no mesmíssimo instante. Encerrando por segurança; tente novamente.`
            );
        }
        throw err;
    }
    try {
        fs.writeSync(fd, payload);
    } finally {
        fs.closeSync(fd);
    }
    return lockPath;
}

/**
 * Libera o lock — só remove o arquivo se ele ainda pertencer a ESTE
 * processo (evita apagar por engano o lock de uma instância mais nova, num
 * cenário improvável de release tardio/fora de ordem).
 */
function releaseInstanceLock(dbPath) {
    const lockPath = lockPathFor(dbPath);
    const info = readLockInfo(lockPath);
    if (info && info.pid === process.pid) {
        try { fs.unlinkSync(lockPath); } catch { /* já pode ter sumido */ }
    }
}

module.exports = { acquireInstanceLock, releaseInstanceLock, lockPathFor, isPidAlive };
