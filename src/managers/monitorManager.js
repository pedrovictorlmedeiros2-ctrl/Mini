/**
 * GERENCIADOR DE MONITORAMENTO — v8.5.2
 *
 * Melhorias:
 * - Aviso suave (soft warning) antes de matar o bot por recurso
 * - Não tenta pidusage em containers (pid 0 / entry.container)
 * - Cooldown de aviso pra não floodar o dono
 * - Recuperação de saúde só quando realmente está saudável
 * - Intervalo configurável via env MONITOR_INTERVAL_MS
 */
const os = require('os');
const pidusage = require('pidusage');
const { query, run, get } = require('../database/database');
const { activeProcesses, stopBot } = require('./processManager');
const { addLog } = require('./consoleManager');
const { alertResourceLimit, alertResourceWarning } = require('./alertManager');
const { updateHealth } = require('./healthManager');
const config = require('../../config');

let monitorInterval = null;
let statusUpdateCounter = 0;
let lastUptimeUpdate = Date.now();

// Cooldown de aviso por bot (não manda DM a cada ciclo)
const warningCooldown = new Map(); // botId → timestamp
const WARNING_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos

/**
 * Inicia o ciclo de monitoramento
 */
function startMonitoring(intervalMs) {
    const ms = intervalMs || Number(process.env.MONITOR_INTERVAL_MS) || 30000;
    if (monitorInterval) clearInterval(monitorInterval);

    monitorInterval = setInterval(async () => {
        const onlineBots = Array.from(activeProcesses.entries());
        // Guarda o maior consumidor de RAM deste ciclo, pro disjuntor de
        // emergência do host abaixo (evita chamar pidusage de novo).
        let biggestRamBot = null; // { botId, ramUsageMB }

        for (const [botId, entry] of onlineBots) {
            try {
                // Containers não têm PID real no host → pula medição por pidusage
                if (entry.container || !entry.process || entry.process.killed || !entry.process.pid) {
                    continue;
                }

                // CORREÇÃO (integração do SandboxManager): quando o bot roda
                // no LinuxSandboxBackend, entry.process.pid é o PID do
                // supervisor bwrap, não o processo real do bot (que vive
                // como PID separado DENTRO do PID namespace do sandbox,
                // invisível pro Node que só rastreia o processo que ele
                // mesmo criou). pidusage(pid do bwrap) mediria só o
                // supervisor — praticamente ocioso — dando uma leitura de
                // RAM/CPU falsamente baixa. O cgroup v2 tem a contagem
                // CORRETA (memory.current é o total real do processo lá
                // dentro), então usamos ela quando disponível. CPU não é
                // recalculada a partir de cpu.stat aqui (precisaria de
                // amostragem por delta de tempo, escopo maior) — mas isso
                // não é uma lacuna de segurança: o cgroup cpu.max já limita
                // o uso de CPU diretamente no kernel, então esse watchdog
                // (que reage por polling) é só uma camada redundante nesse
                // caso, não a única linha de defesa como é no modo reduzido.
                const usingKernelSandbox = entry.sandbox && typeof entry.sandbox.metrics === 'function' && entry.sandbox.status?.().backend === 'linux';

                let cpuUsage = null;
                let ramUsageMB;

                if (usingKernelSandbox) {
                    const m = entry.sandbox.metrics();
                    if (!m || m.memoryCurrentBytes == null) continue; // cgroup ainda não populado neste ciclo
                    ramUsageMB = m.memoryCurrentBytes / 1024 / 1024;

                    // KAMIKAZE MODE: padrões de fork-bomb (pids.current no
                    // teto do cgroup) e de resource-exhaustion (kernel
                    // matando o processo por OOM) são sinais de segurança,
                    // não só números de recurso — o watchdog comum
                    // (warn/kill abaixo) continua idêntico pro "mau
                    // comportamento normal"; isto é uma camada adicional,
                    // em paralelo, só pra alimentar o SecurityEngine.
                    try {
                        const { reportSignal } = require('./security/SecurityEngine');
                        const pidsMax = entry.sandbox.limits?.pids;
                        if (pidsMax && m.pidsCurrent != null && m.pidsCurrent >= pidsMax) {
                            reportSignal({ botId, source: 'cgroup', code: 'pids_ceiling', details: { pidsCurrent: m.pidsCurrent, pidsMax } });
                        }
                        if (m.oomKillCount != null && m.oomKillCount > (entry.lastOomKillCount || 0)) {
                            reportSignal({ botId, source: 'cgroup', code: 'oom_kill', details: { oomKillCount: m.oomKillCount } });
                        }
                        entry.lastOomKillCount = m.oomKillCount || 0;
                    } catch (_) { /* nunca quebra o watchdog por causa disso */ }
                } else {
                    const stats = await pidusage(entry.process.pid);
                    cpuUsage = stats.cpu;
                    ramUsageMB = stats.memory / 1024 / 1024;
                }

                // Limites efetivos: override do bot > plano do dono > default global
                const limits = get(
                    `SELECT
                        COALESCE(b.max_cpu_limit, u.max_cpu, ?) AS max_cpu,
                        COALESCE(b.max_memory, u.max_ram, ?) AS max_ram
                     FROM bots b
                     LEFT JOIN users u ON u.id = b.creator_id
                     WHERE b.id = ?`,
                    [config.security.maxCpuPerBot, config.security.maxRamPerBot, botId]
                );

                if (!biggestRamBot || ramUsageMB > biggestRamBot.ramUsageMB) {
                    biggestRamBot = { botId, ramUsageMB };
                }

                // Atualiza no banco (cpu_usage fica null quando medido via
                // kernel sandbox — não temos %CPU calculada nesse caso, mas
                // não fingimos um número que não temos)
                run(
                    "UPDATE bots SET cpu_usage = ?, ram_usage = ?, last_activity = datetime('now') WHERE id = ?",
                    [cpuUsage != null ? cpuUsage.toFixed(1) : null, ramUsageMB.toFixed(1), botId]
                );

                if (!limits) continue;

                const maxRam = Number(limits.max_ram) || config.security.maxRamPerBot;
                const maxCpu = Number(limits.max_cpu) || config.security.maxCpuPerBot;

                // Thresholds
                const ramWarn = maxRam * 0.85;   // 85% → aviso
                const cpuWarn = maxCpu * 0.90;   // 90% → aviso
                let killReason = null;
                let warnReason = null;

                // ── RAM ──────────────────────────────────────────────────────
                if (ramUsageMB > maxRam) {
                    killReason = `Excedeu limite de RAM (${ramUsageMB.toFixed(1)}MB / ${maxRam}MB)`;
                } else if (ramUsageMB > ramWarn) {
                    warnReason = `RAM alta: ${ramUsageMB.toFixed(1)}MB de ${maxRam}MB (${((ramUsageMB / maxRam) * 100).toFixed(0)}%)`;
                }

                // ── CPU ────────────────────────────────────────────────────
                // Pulado quando cpuUsage é null (backend 'linux'): o cgroup
                // cpu.max já limita isso diretamente no kernel.
                if (!killReason && cpuUsage != null) {
                    if (cpuUsage > maxCpu) {
                        // Picos curtos são tolerados. Só mata no 2º ciclo seguido.
                        if (!entry.cpuExceeded) {
                            entry.cpuExceeded = true;
                            warnReason = warnReason || `CPU alta: ${cpuUsage.toFixed(1)}% de ${maxCpu}%`;
                        } else {
                            killReason = `Excedeu limite de CPU (${cpuUsage.toFixed(1)}% / ${maxCpu}%) por tempo prolongado`;
                        }
                    } else {
                        entry.cpuExceeded = false;
                        if (cpuUsage > cpuWarn) {
                            warnReason = warnReason || `CPU elevada: ${cpuUsage.toFixed(1)}% de ${maxCpu}%`;
                        }
                    }
                }

                // ── AÇÃO ─────────────────────────────────────────────────────
                if (killReason) {
                    addLog(botId, `🛑 WATCHDOG: Bot desligado. Motivo: ${killReason}`, 'stderr');
                    alertResourceLimit(botId, killReason);
                    updateHealth(botId, 'watchdog');
                    console.warn(`[WATCHDOG] Bot ${botId} encerrado: ${killReason}`);
                    stopBot(botId);
                    warningCooldown.delete(botId);
                } else if (warnReason) {
                    // Soft warning com cooldown
                    const lastWarn = warningCooldown.get(botId) || 0;
                    if (Date.now() - lastWarn > WARNING_COOLDOWN_MS) {
                        warningCooldown.set(botId, Date.now());
                        addLog(botId, `🟡 AVISO: ${warnReason}`, 'stdout');
                        alertResourceWarning(botId, warnReason);
                        console.warn(`[WATCHDOG-WARN] Bot ${botId}: ${warnReason}`);
                    }
                } else {
                    // Saudável → recupera score
                    updateHealth(botId, 'heartbeat');
                }
            } catch (err) {
                // Processo pode ter morrido entre o check e o pidusage — ignora
            }
        }

        // Limpa cache do pidusage (evita leak)
        try { pidusage.clear(); } catch {}

        // ── DISJUNTOR DE EMERGÊNCIA DO HOST ────────────────────────────────
        // CORREÇÃO DE SEGURANÇA (item #8 da revisão): os limites acima são
        // por bot, medidos a cada ciclo (até 30s de atraso por padrão). Vários
        // bots crescendo juntos, ou um crescendo rápido demais, podem estourar
        // a RAM do host inteiro antes do próximo ciclo perceber. Isso aqui é
        // a segunda linha de defesa: mede a RAM REAL do sistema operacional
        // (não só a soma calculada dos bots) e, se estiver crítica, mata na
        // hora o bot que mais consome — não espera o próximo ciclo.
        try {
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedPercent = ((totalMem - freeMem) / totalMem) * 100;
            const emergencyThreshold = Number(process.env.HOST_EMERGENCY_RAM_PERCENT) || 90;

            if (usedPercent >= emergencyThreshold && biggestRamBot) {
                const { botId, ramUsageMB } = biggestRamBot;
                const reason = `Disjuntor de emergência: RAM do HOST em ${usedPercent.toFixed(1)}% (limite ${emergencyThreshold}%). Bot mais pesado (${ramUsageMB.toFixed(0)}MB) desligado pra proteger o PC.`;
                addLog(botId, `🆘 ${reason}`, 'stderr');
                alertResourceLimit(botId, reason);
                updateHealth(botId, 'watchdog');
                console.warn(`[WATCHDOG-EMERGENCY] Host em ${usedPercent.toFixed(1)}% de RAM. Encerrando bot ${botId} (${ramUsageMB.toFixed(0)}MB).`);
                stopBot(botId);
                warningCooldown.delete(botId);
            }
        } catch { /* nunca deixa o disjuntor derrubar o próprio watchdog */ }

        // Atualiza canais de status + verifica planos a cada 5 ciclos
        statusUpdateCounter++;
        if (statusUpdateCounter >= 5) {
            statusUpdateCounter = 0;
            await updateStatusChannels();
            await checkPlanExpirations();
        }
    }, ms);

    console.log(`📊 Monitoramento de recursos iniciado (${ms / 1000}s).`);
}

function stopMonitoring() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
}

/**
 * Atualiza os nomes dos canais de status no Discord
 */
async function updateStatusChannels() {
    const { getClient } = require('../utils/clientRef');
    const client = getClient();
    if (!client || !client.isReady()) return;

    const channels = config.notifications?.statusChannels;
    if (!channels) return;

    try {
        if (channels.members) {
            const guild = client.guilds.cache.get(config.bot.guildId);
            const channel = client.channels.cache.get(channels.members);
            if (guild && channel) {
                await channel.setName(`🚀┃Membros: ${guild.memberCount}`).catch(() => {});
            }
        }

        if (channels.ping) {
            const channel = client.channels.cache.get(channels.ping);
            if (channel) {
                await channel.setName(`📶┃Ping: ${client.ws.ping}ms`).catch(() => {});
            }
        }

        if (channels.bots) {
            const channel = client.channels.cache.get(channels.bots);
            if (channel) {
                const row = get("SELECT COUNT(*) as total FROM bots WHERE status = 'online'");
                const count = row?.total ?? 0;
                await channel.setName(`🤖┃Bots Online: ${count}`).catch(() => {});
            }
        }

        if (channels.uptime) {
            const channel = client.channels.cache.get(channels.uptime);
            if (channel) {
                const uptime = Math.floor((Date.now() - lastUptimeUpdate) / 1000 / 60);
                await channel.setName(`⏱┃Host Uptime: ${uptime}m`).catch(() => {});
            }
        }
    } catch {
        // Rate limit do Discord — ignora
    }
}

/**
 * Verifica planos expirados e envia avisos
 */
async function checkPlanExpirations() {
    const { getClient } = require('../utils/clientRef');
    const client = getClient();
    if (!client || !client.isReady()) return;

    try {
        // 1. Avisar quem expira em 3 dias
        const expiringSoon = query(
            "SELECT id, plan_name FROM users WHERE plan_expiry IS NOT NULL AND plan_expiry > datetime('now') AND plan_expiry < datetime('now', '+3 days') AND notified_expiry = 0"
        );

        for (const user of expiringSoon) {
            const discordUser = await client.users.fetch(user.id).catch(() => null);
            if (discordUser) {
                await discordUser.send(
                    `⚠️ **Aviso de Expiração:** Seu plano **${user.plan_name.toUpperCase()}** expira em menos de 3 dias. Renove agora para evitar a interrupção dos seus serviços!`
                ).catch(() => {});
                run('UPDATE users SET notified_expiry = 1 WHERE id = ?', [user.id]);
            }
        }

        // 2. Rebaixa quem já expirou
        const expired = query(
            "SELECT id FROM users WHERE plan_expiry IS NOT NULL AND plan_expiry <= datetime('now') AND plan_name != 'free'"
        );

        for (const user of expired) {
            console.log(`[EXPIRATION] Plano do usuário ${user.id} expirou. Retornando ao plano free.`);
            run("UPDATE users SET plan_name = 'free', plan_expiry = NULL, notified_expiry = 0 WHERE id = ?", [user.id]);

            const discordUser = await client.users.fetch(user.id).catch(() => null);
            if (discordUser) {
                await discordUser.send(
                    `🔴 **Plano Expirado:** Seu plano de hospedagem expirou e sua conta retornou ao nível **FREE**. Alguns recursos podem ter sido limitados.`
                ).catch(() => {});
            }
        }
    } catch (err) {
        console.error('Erro ao verificar expirações:', err);
    }
}

module.exports = { startMonitoring, stopMonitoring };
