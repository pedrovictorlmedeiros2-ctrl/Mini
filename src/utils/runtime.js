const { execSync } = require('child_process');

function isWindows() {
    return process.platform === 'win32';
}

function commandExists(cmd) {
    const normalized = String(cmd).trim();
    if (!normalized) return false;

    const target = isWindows() ? normalized.replace(/\.exe$/i, '') : normalized;
    const command = isWindows() ? `where.exe ${target}` : `which ${target}`;

    try {
        execSync(command, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

module.exports = { isWindows, commandExists };
