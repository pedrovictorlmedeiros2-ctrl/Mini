/**
 * COMANDO /diagnostico
 *
 * NOVA FEATURE: um comando único que verifica a saúde geral do servidor de
 * hospedagem — pensado pra staff rodar rapidamente quando algo parece
 * errado, sem precisar entrar no servidor via SSH/Termux pra checar cada
 * coisa manualmente.
 *
 * Honestidade sobre os limites: isto roda dentro do processo Node do painel,
 * então só consegue checar o que é possível checar de dentro do processo
 * (sem privilégios de root/admin do SO). Não existe checagem real de
 * "firewall" aqui — isso exigiria acesso a ferramentas do SO (iptables/ufw)
 * que variam demais entre Termux/Linux/Windows para uma checagem confiável
 * e seria fácil de exibir um falso positivo/negativo. Prefiro não fingir
 * checar isso a mostrar um "✓ Firewall OK" que não significa nada de verdade.
 */
const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const si = require('systeminformation');
const config = require('../../config');
const { get, query } = require('../database/database');
const { formatBytes } = require('../utils/format');
const { activeProcesses } = require('../managers/processManager');

function commandVersion(cmd) {
    try {
        return execSync(`${cmd} --version`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0];
    } catch {
        return null;
    }
}

function canWriteTo(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const testFile = path.join(dir, `.write_test_${Date.now()}`);
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('diagnostico')
        .setDescription('[Staff] Verifica a saúde geral do servidor de hospedagem')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });

        const checks = [];
        const check = (label, ok, detail = '') => checks.push({ label, ok, detail });

        // ── RUNTIMES ──
        check('Node.js', true, `${process.version} (usado pelo próprio painel)`);
        const pythonVer = commandVersion('python3') || commandVersion('python');
        check('Python', !!pythonVer, pythonVer || 'não encontrado no PATH');
        const javaVer = commandVersion('java');
        check('Java', !!javaVer, javaVer || 'não encontrado no PATH (necessário só para bots Minecraft)');

        // ── DISCO ──
        try {
            const disks = await si.fsSize();
            const main = disks[0];
            const freePct = main ? Math.round(100 - main.use) : null;
            check('Disco', freePct === null || freePct > 5, main ? `${formatBytes(main.size - main.used)} livres de ${formatBytes(main.size)} (${main.use.toFixed(1)}% usado)` : 'não foi possível ler');
        } catch (err) {
            check('Disco', false, `erro ao verificar: ${err.message}`);
        }

        // ── MEMÓRIA ──
        try {
            const mem = await si.mem();
            const freePct = Math.round((mem.available / mem.total) * 100);
            check('Memória', freePct > 10, `${formatBytes(mem.available)} disponíveis de ${formatBytes(mem.total)} (${freePct}% livre)`);
        } catch (err) {
            check('Memória', false, `erro ao verificar: ${err.message}`);
        }

        // ── BANCO DE DADOS ──
        try {
            const botCount = get('SELECT COUNT(*) as c FROM bots').c;
            check('Banco de Dados', true, `respondendo (${botCount} bot(s) cadastrado(s))`);
        } catch (err) {
            check('Banco de Dados', false, `erro: ${err.message}`);
        }

        // ── PERMISSÕES DE ESCRITA ──
        const folders = [
            ['Pasta de bots', config.system.botsFolder],
            ['Pasta de backups', config.system.backupsFolder],
            ['Pasta de logs', config.system.logsFolder],
        ];
        for (const [label, dir] of folders) {
            check(label, canWriteTo(path.resolve(dir)), path.resolve(dir));
        }

        // ── PROCESSOS ──
        const onlineInDb = get("SELECT COUNT(*) as c FROM bots WHERE status = 'online'").c;
        const onlineInMemory = activeProcesses.size;
        const processesMatch = onlineInDb === onlineInMemory;
        check('Processos', processesMatch, `Banco diz ${onlineInDb} online, processo tem ${onlineInMemory} rodando de fato${processesMatch ? '' : ' — ⚠️ dessincronizado, considere reiniciar o painel'}`);

        // ── CRASH LOOPS ──
        const crashLoopCount = get("SELECT COUNT(*) as c FROM bots WHERE health_status = 'crash_loop'").c;
        check('Bots em Crash Loop', crashLoopCount === 0, crashLoopCount > 0 ? `${crashLoopCount} bot(s) precisam de atenção manual` : 'nenhum');

        // ── BACKUPS ──
        try {
            const totalBackups = get('SELECT COUNT(*) as c FROM backups').c;
            const encryptedBackups = get('SELECT COUNT(*) as c FROM backups WHERE encrypted = 1').c;
            check('Backups', true, `${totalBackups} total (${encryptedBackups} criptografado(s))`);
        } catch (err) {
            check('Backups', false, `erro: ${err.message}`);
        }

        // ── CONFIGURAÇÃO CRÍTICA ──
        check('ENCRYPTION_KEY configurada', !!(config.security.encryptionKey && config.security.encryptionKey.length >= 16), 'validado no boot — se chegou até aqui, está ok');
        // CORREÇÃO: checava a variável errada. O token do PRÓPRIO painel fica em
        // BOT_TOKEN (ver config.js e index.js) — DISCORD_TOKEN é só o nome usado
        // nas variáveis de ambiente dos bots HOSPEDADOS (processManager.js), uma
        // env var completamente diferente. Isso fazia /diagnostico sempre acusar
        // "ausente" mesmo com o painel logado e funcionando normalmente.
        check('BOT_TOKEN configurado', !!process.env.BOT_TOKEN, process.env.BOT_TOKEN ? 'presente' : 'ausente');

        const failedChecks = checks.filter(c => !c.ok);
        const embed = new EmbedBuilder()
            .setColor(failedChecks.length === 0 ? '#00FF00' : failedChecks.length <= 2 ? '#FFAA00' : '#FF0000')
            .setTitle(`🩺 Diagnóstico do Servidor`)
            .setDescription(
                failedChecks.length === 0
                    ? '✅ Tudo certo! Nenhum problema encontrado.'
                    : `⚠️ ${failedChecks.length} item(ns) precisam de atenção.`
            )
            .addFields(
                checks.map(c => ({
                    name: `${c.ok ? '✅' : '❌'} ${c.label}`,
                    value: c.detail || '\u200b',
                    inline: false,
                }))
            )
            .setFooter({ text: 'Checagens rodam dentro do processo do painel — sem acesso root do SO, algumas coisas (ex: firewall) não são verificáveis daqui.' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }
};
