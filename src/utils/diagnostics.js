const os = require('os');
const { commandExists } = require('./runtime');

function collectRuntimeSnapshot() {
    const env = {
        BOT_TOKEN: Boolean(process.env.BOT_TOKEN),
        CLIENT_ID: Boolean(process.env.CLIENT_ID),
        ENCRYPTION_KEY: Boolean(process.env.ENCRYPTION_KEY),
        OWNER_ID: Boolean(process.env.OWNER_ID),
        GITHUB_WEBHOOK_SECRET: Boolean(process.env.GITHUB_WEBHOOK_SECRET),
    };

    return {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        cwd: process.cwd(),
        cpuCount: os.cpus().length,
        totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
        freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
        env,
        tools: {
            git: commandExists('git'),
            docker: commandExists('docker'),
            python: commandExists('python') || commandExists('python3'),
        },
    };
}

function logStartupDiagnostics() {
    const snapshot = collectRuntimeSnapshot();
    console.log('[BOOT] Runtime diagnostics');
    console.log(`[BOOT] Node: ${snapshot.nodeVersion} | Platform: ${snapshot.platform}/${snapshot.arch}`);
    console.log(`[BOOT] CPUs: ${snapshot.cpuCount} | RAM: ${snapshot.totalMemoryMb}MB total / ${snapshot.freeMemoryMb}MB free`);
    console.log(`[BOOT] Env: BOT_TOKEN=${snapshot.env.BOT_TOKEN ? 'set' : 'missing'} | CLIENT_ID=${snapshot.env.CLIENT_ID ? 'set' : 'missing'} | ENCRYPTION_KEY=${snapshot.env.ENCRYPTION_KEY ? 'set' : 'missing'} | OWNER_ID=${snapshot.env.OWNER_ID ? 'set' : 'missing'}`);
    console.log(`[BOOT] Tools: git=${snapshot.tools.git ? 'yes' : 'no'} | docker=${snapshot.tools.docker ? 'yes' : 'no'} | python=${snapshot.tools.python ? 'yes' : 'no'}`);
    console.log(`[BOOT] Working directory: ${snapshot.cwd}`);
}

module.exports = { collectRuntimeSnapshot, logStartupDiagnostics };
