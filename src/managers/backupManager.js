/**
 * GERENCIADOR DE BACKUPS
 * Cria, restaura e gerencia backups dos bots
 *
 * Correções aplicadas:
 * - Pasta de backups é criada automaticamente antes de gravar o ZIP (evita ENOENT)
 * - Restauração valida entradas do ZIP contra zip-slip (consistente com o upload)
 * - cleanupOldBackups remove o arquivo do disco antes de deletar do banco
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { run, query, get } = require('../database/database');
const config = require('../../config');
const { addToQueue } = require('./queueManager');
const { encryptBuffer, decryptBuffer, sha256 } = require('../utils/fileCrypto');
const { pushBackupOffsite } = require('./offsiteBackup');
const { validateZipEntries } = require('../utils/zipValidation');

/**
 * Garante que a pasta de backups existe antes de qualquer operação
 */
function ensureBackupFolder() {
    if (!fs.existsSync(config.system.backupsFolder)) {
        fs.mkdirSync(config.system.backupsFolder, { recursive: true });
    }
}

/**
 * Cria backup de um bot
 * @param {string} botId
 * @param {string} type - 'manual' | 'auto' | 'daily' | 'weekly' | 'monthly'
 *
 * CORREÇÃO (feature nova): o ZIP do backup ficava gravado em texto puro no
 * disco — qualquer um com acesso ao servidor (ou a um disco comprometido)
 * conseguia ler o código-fonte e os dados de qualquer bot direto dos backups.
 * Agora o conteúdo é criptografado (AES-256-GCM) antes de tocar o disco, e
 * guardamos um SHA-256 do conteúdo original para verificar integridade na
 * restauração — se o arquivo for corrompido ou adulterado, a restauração é
 * bloqueada em vez de aplicar dados quebrados/maliciosos.
 */
async function createBackup(botId, type = 'manual') {
    return addToQueue(async () => {
        const bot = get('SELECT * FROM bots WHERE id = ?', [botId]);
        if (!bot) throw new Error('Bot não encontrado');

        const sourcePath = path.resolve(bot.folder_path);
        if (!fs.existsSync(sourcePath)) throw new Error('Pasta do bot não encontrada');

        ensureBackupFolder();

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${bot.code}_${timestamp}.zip.enc`;
        const backupPath = path.join(config.system.backupsFolder, filename);

        // Monta o ZIP inteiro em memória (não precisa tocar o disco em texto
        // puro em nenhum momento) e só então criptografa o resultado.
        const zip = new AdmZip();
        zip.addLocalFolder(sourcePath);
        const plainBuffer = zip.toBuffer();

        const checksum = sha256(plainBuffer);
        const encryptedBuffer = encryptBuffer(plainBuffer);
        fs.writeFileSync(backupPath, encryptedBuffer);

        run(
            'INSERT INTO backups (bot_id, file_path, size, type, checksum, encrypted) VALUES (?, ?, ?, ?, ?, 1)',
            [botId, backupPath, encryptedBuffer.length, type, checksum]
        );
        // Offsite (best-effort, não bloqueia o backup local)
        try { await pushBackupOffsite(backupPath, bot.code); } catch (e) { console.warn('[OFFSITE]', e.message); }

        cleanupOldBackups(botId);

        return { path: backupPath, size: encryptedBuffer.length, checksum };
    }, `Backup do bot ${botId}`);
}

/**
 * Restaura um backup com validação de zip-slip e rollback automático
 * @param {string|number} backupId
 */
async function restoreBackup(backupId) {
    return addToQueue(async () => {
        const backup = get('SELECT * FROM backups WHERE id = ?', [backupId]);
        if (!backup) throw new Error('Backup não encontrado');

        const bot = get('SELECT * FROM bots WHERE id = ?', [backup.bot_id]);
        if (!bot) throw new Error('Bot não encontrado');

        if (!fs.existsSync(backup.file_path)) {
            throw new Error('Arquivo de backup não encontrado no disco.');
        }

        // CORREÇÃO: trocar os arquivos de um bot enquanto o processo dele ainda
        // está rodando pode deixá-lo em estado inconsistente (arquivos abertos
        // apontando pro caminho antigo, banco SQLite com WAL aberto, etc.).
        // Paramos o bot antes de mexer na pasta e religamos depois, se estava online.
        const wasOnline = bot.status === 'online';
        if (wasOnline) {
            const { stopBot } = require('./processManager');
            await stopBot(bot.id).catch(err => {
                throw new Error(`Não foi possível parar o bot antes de restaurar o backup: ${err.message}`);
            });
        }

        const targetPath = path.resolve(bot.folder_path);
        const tempPath = `${targetPath}.restoring-${Date.now()}`;
        const oldPath = `${targetPath}.old-${Date.now()}`;

        // CORREÇÃO (feature nova): backups agora são criptografados (AES-256-GCM)
        // e verificados por SHA-256 antes de restaurar. Mantemos compatibilidade
        // com backups antigos (criados antes desta versão), que ainda são ZIPs
        // em texto puro sem checksum — identificados pela flag 'encrypted'.
        let zipBuffer;
        if (backup.encrypted) {
            const encryptedBuffer = fs.readFileSync(backup.file_path);
            try {
                zipBuffer = decryptBuffer(encryptedBuffer);
            } catch (err) {
                throw new Error(`Backup corrompido ou adulterado — falha na descriptografia/autenticação: ${err.message}`);
            }

            if (backup.checksum) {
                const actualChecksum = sha256(zipBuffer);
                if (actualChecksum !== backup.checksum) {
                    throw new Error('Backup corrompido: o checksum SHA-256 não confere com o registrado na criação. Restauração bloqueada por segurança.');
                }
            }
        } else {
            // Backup legado (pré-criptografia): lido como ZIP puro, sem checksum pra validar.
            zipBuffer = fs.readFileSync(backup.file_path);
        }

        const zip = new AdmZip(zipBuffer);
        const entries = zip.getEntries();
        const destRoot = path.resolve(tempPath);
        // CORREÇÃO: esta era uma TERCEIRA cópia da mesma checagem de zip-slip,
        // desatualizada em relação à de src/utils/zipValidation.js (não pegava
        // a barra invertida, achada em teste de invasão real — ver
        // deployBotFromZip). Restauração de backup agora usa o mesmo módulo
        // testado, e ganha de brinde a proteção contra zip bomb que faltava aqui.
        validateZipEntries(entries, destRoot, {
            maxEntries: config.security.maxZipEntries,
            maxUnzippedSizeMB: config.security.maxUnzippedSizeMB,
        });

        fs.mkdirSync(tempPath, { recursive: true });
        try {
            zip.extractAllTo(tempPath, true);
        } catch (err) {
            fs.rmSync(tempPath, { recursive: true, force: true });
            throw new Error(`Backup corrompido ou inválido, restauração cancelada: ${err.message}`);
        }

        try {
            if (fs.existsSync(targetPath)) {
                fs.renameSync(targetPath, oldPath);
            }
            fs.renameSync(tempPath, targetPath);
        } catch (err) {
            if (fs.existsSync(oldPath) && !fs.existsSync(targetPath)) {
                fs.renameSync(oldPath, targetPath);
            }
            fs.rmSync(tempPath, { recursive: true, force: true });
            throw new Error(`Falha ao aplicar a restauração, nada foi alterado: ${err.message}`);
        }

        if (fs.existsSync(oldPath)) {
            fs.rmSync(oldPath, { recursive: true, force: true });
        }

        if (wasOnline) {
            const { startBot } = require('./processManager');
            await startBot(bot.id).catch(err => {
                console.error(`⚠️ Backup restaurado, mas falha ao reiniciar o bot ${bot.id}:`, err.message);
            });
        }

        return true;
    }, `Restauração do backup ${backupId}`);
}

/**
 * Lista backups de um bot ordenados do mais recente ao mais antigo
 * @param {string} botId
 */
function listBackups(botId) {
    return query(
        'SELECT * FROM backups WHERE bot_id = ? ORDER BY created_at DESC',
        [botId]
    );
}

/**
 * Remove backups antigos mantendo apenas os N mais recentes
 * @param {string} botId
 */
function cleanupOldBackups(botId) {
    const backups = query(
        'SELECT id FROM backups WHERE bot_id = ? ORDER BY created_at DESC',
        [botId]
    );
    if (backups.length > config.backup.keepBackups) {
        const toDelete = backups.slice(config.backup.keepBackups);
        for (const b of toDelete) {
            const bk = get('SELECT file_path FROM backups WHERE id = ?', [b.id]);
            if (bk) {
                // Remove o arquivo do disco antes de deletar o registro
                if (fs.existsSync(bk.file_path)) {
                    try { fs.unlinkSync(bk.file_path); } catch { /* Ignora */ }
                }
                run('DELETE FROM backups WHERE id = ?', [b.id]);
            }
        }
    }
}

module.exports = {
    createBackup,
    restoreBackup,
    listBackups,
    cleanupOldBackups,
};
