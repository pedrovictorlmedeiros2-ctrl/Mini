/**
 * Monta os argumentos de bind mount do bwrap pros diretórios básicos do
 * sistema (/usr, /bin, /lib, /lib64, /sbin) — necessários pra qualquer
 * binário dentro do sandbox rodar (dynamic linker, libc, etc.).
 *
 * Distros modernas com 'usrmerge' (Debian 10+/Ubuntu 17.04+/Fedora/Arch)
 * têm /bin, /lib, /lib64, /sbin como symlinks pra dentro de /usr. Distros
 * mais antigas (estilo FHS clássico) têm esses diretórios reais e
 * separados. bwrap começa com um root vazio — nada existe dentro do
 * sandbox que não seja explicitamente montado/linkado, então esta função
 * decide qual estratégia usar checando o sistema real, em vez de assumir.
 */
const fs = require('fs');

function isSymlink(p) {
    try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function exists(p) {
    try { fs.statSync(p); return true; } catch { return false; }
}

function buildBaseSystemBindArgs() {
    const args = ['--ro-bind', '/usr', '/usr'];

    // Nos dois modos, /usr é sempre bind montado. A diferença é como
    // /bin, /lib, /lib64 e /sbin aparecem dentro do sandbox.
    const candidates = ['/bin', '/lib', '/lib64', '/sbin'];
    for (const dir of candidates) {
        if (!exists(dir)) continue; // ex: /lib64 não existe em alguns sistemas 32-bit puros
        if (isSymlink(dir)) {
            // usrmerge: recria o symlink (ex: /bin -> usr/bin) dentro do sandbox
            const target = fs.readlinkSync(dir);
            // normaliza pra caminho relativo tipo 'usr/bin' (o que --symlink espera)
            const relTarget = target.replace(/^\/+/, '');
            args.push('--symlink', relTarget, dir);
        } else {
            // FHS tradicional: o diretório é real e separado de /usr, bind à parte
            args.push('--ro-bind', dir, dir);
        }
    }

    return args;
}

module.exports = { buildBaseSystemBindArgs };
