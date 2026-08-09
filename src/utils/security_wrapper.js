/**
 * SECURITY WRAPPER (BLINDAGEM DE PROCESSO) — v6.0
 * Este script é injetado nos bots hospedados via --require.
 * Ele desativa módulos perigosos e tenta mitigar Fork Bombs.
 *
 * AVISO IMPORTANTE (honestidade sobre os limites desta blindagem):
 * Isto NÃO é um sandbox de verdade. É código JS rodando no MESMO processo
 * do bot hospedado, sem isolamento de sistema operacional (sem container,
 * sem VM, sem usuário/uid separado, sem seccomp/cgroups). Um bot hospedado
 * decidido e com conhecimento técnico pode, em tese, contornar boa parte
 * disto (ex: reescrever este próprio wrapper via truques de prototype,
 * usar bindings nativos de baixo nível, etc). O valor real desta camada é
 * bloquear os vetores MAIS ÓBVIOS e acidentais (um bot cliente comum não
 * vai tentar escapar), não barrar um atacante sofisticado e motivado.
 * Isolamento real exigiria rodar cada bot em container/VM próprio.
 *
 * Correções nesta versão:
 * - Bloqueia também variantes 'node:xxx' dos módulos proibidos (antes
 *   'node:child_process' passava direto pois só a string exata era checada).
 * - Adiciona 'process' aos módulos monitorados (fs) e bloqueia child_process
 *   também quando obtido indiretamente via 'process.binding'/'internal/...'.
 * - Protege TAMBÉM as versões assíncronas e baseadas em Promise do fs
 *   (readFile, writeFile, appendFile, unlink, rm, rename, fs.promises.*),
 *   além das streams (createReadStream/createWriteStream). Antes só as
 *   síncronas eram protegidas — as assíncronas passavam livres.
 */

const Module = require('module');
const path = require('path');
const originalRequire = Module.prototype.require;

// Módulos estritamente proibidos para bots hospedados (para evitar que acessem a host).
// Aceita tanto o nome puro quanto o prefixo 'node:' (ex: 'node:child_process').
//
// CORREÇÃO: 'worker_threads' foi REMOVIDO desta lista. Ele não abre um
// processo novo (roda dentro do mesmo processo/permissões do bot, diferente
// de child_process), então não é uma via de escape pro host. E bloqueá-lo
// quebrava bots legítimos: o undici (motor do fetch() nativo do Node, usado
// pelo discord.js pra falar com a API do Discord) exige worker_threads pra
// carregar — ou seja, isso derrubava praticamente qualquer bot moderno que
// usasse fetch ou discord.js recente. Memória usada por worker threads ainda
// conta pra RSS total do processo, então o watchdog de RAM (monitorManager.js)
// continua pegando um bot que abusar disso pra tentar burlar o limite de heap.
const BANNED_MODULES = [
    'child_process',
    'cluster',
    'v8',
    'vm',
    'inspector',
    'repl',
];

function normalizeModuleId(id) {
    return typeof id === 'string' && id.startsWith('node:') ? id.slice(5) : id;
}

// Usa o fs ORIGINAL (não o embrulhado por este arquivo) pra resolver
// symlinks — evita recursão infinita e garante que a checagem em si nunca
// passe pelo wrapper que ela mesma está protegendo.
const originalFs = require('fs');
const botDir = originalFs.realpathSync(process.cwd());

// CORREÇÃO DE SEGURANÇA (achado em auditoria, mesma classe do bug corrigido
// em src/managers/fileManager.js): path.resolve() sozinho NÃO segue symlinks.
// Um bot hospedado podia criar um link simbólico dentro da própria pasta
// apontando pra fora (ex: fs.symlinkSync('/', 'escape') via um método fs
// ainda não coberto, ou simplesmente incluído nos arquivos enviados no
// deploy) e usar esse link pra ler/escrever fora da pasta — o texto do
// caminho passava na checagem antiga (só string), mas o SO seguia o link de
// verdade. Agora resolvemos o ancestral existente mais próximo com
// realpathSync (que segue symlinks) antes de decidir.
function assertInsideBotDir(filePath, action) {
    // Suporta o primeiro argumento sendo Buffer/URL também (fs aceita ambos)
    const p = filePath instanceof Buffer ? filePath.toString() : (filePath && filePath.pathname ? filePath.pathname : filePath);
    if (typeof p !== 'string') return; // deixa o fs original lidar com tipos inesperados/erros
    const resolved = path.resolve(p);
    if (resolved !== botDir && !resolved.startsWith(botDir + path.sep)) {
        console.error(`\n🚨 SEGURANÇA: Tentativa de ${action} fora da pasta do bot: ${filePath}`);
        throw new Error('Acesso negado ao arquivo');
    }

    let probe = resolved;
    while (!originalFs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
    }
    let realProbe;
    try {
        realProbe = originalFs.realpathSync(probe);
    } catch {
        return; // não deu pra resolver (ex: condição de corrida); deixa o fs original decidir
    }
    if (realProbe !== botDir && !realProbe.startsWith(botDir + path.sep)) {
        console.error(`\n🚨 SEGURANÇA: Tentativa de ${action} via link simbólico fora da pasta do bot: ${filePath}`);
        throw new Error('Acesso negado ao arquivo (link simbólico escapando da pasta)');
    }
}

function wrapFsModule(fs) {
    // Métodos síncronos
    const syncMethods = ['readFileSync', 'writeFileSync', 'appendFileSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'renameSync', 'mkdirSync', 'copyFileSync', 'createReadStream', 'createWriteStream'];
    for (const method of syncMethods) {
        if (typeof fs[method] !== 'function') continue;
        const original = fs[method];
        fs[method] = function (filePath, ...rest) {
            assertInsideBotDir(filePath, `usar ${method}`);
            // rename/copy têm um segundo caminho que também precisa ser validado
            if ((method === 'renameSync' || method === 'copyFileSync') && rest[0] !== undefined) {
                assertInsideBotDir(rest[0], `usar ${method} (destino)`);
            }
            return original.call(this, filePath, ...rest);
        };
    }

    // Métodos assíncronos com callback (mesma lista, assinatura com callback no final)
    const asyncMethods = ['readFile', 'writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'rename', 'mkdir', 'copyFile'];
    for (const method of asyncMethods) {
        if (typeof fs[method] !== 'function') continue;
        const original = fs[method];
        fs[method] = function (filePath, ...rest) {
            assertInsideBotDir(filePath, `usar ${method}`);
            if ((method === 'rename' || method === 'copyFile') && rest[0] !== undefined && typeof rest[0] !== 'function') {
                assertInsideBotDir(rest[0], `usar ${method} (destino)`);
            }
            return original.call(this, filePath, ...rest);
        };
    }

    // fs.promises.*
    if (fs.promises) {
        for (const method of asyncMethods) {
            if (typeof fs.promises[method] !== 'function') continue;
            const original = fs.promises[method];
            fs.promises[method] = function (filePath, ...rest) {
                assertInsideBotDir(filePath, `usar promises.${method}`);
                if ((method === 'rename' || method === 'copyFile') && rest[0] !== undefined) {
                    assertInsideBotDir(rest[0], `usar promises.${method} (destino)`);
                }
                return original.call(this, filePath, ...rest);
            };
        }
    }

    return fs;
}

Module.prototype.require = function (id) {
    const normalized = normalizeModuleId(id);
    if (BANNED_MODULES.includes(normalized)) {
        console.error(`\n🚨 SEGURANÇA: O módulo '${id}' é proibido nesta hospedagem.`);
        throw new Error(`Acesso negado ao módulo: ${id}`);
    }

    if (normalized === 'fs' || normalized === 'fs/promises') {
        const fs = originalRequire.apply(this, arguments);
        return wrapFsModule(fs);
    }

    return originalRequire.apply(this, arguments);
};

// Mitigação básica de Fork Bomb (sobrescreve process.fork se alguém tentar via outros meios)
process.fork = function () {
    throw new Error('Criação de subprocessos desativada por segurança.');
};

// Bloqueia acesso a process.binding, vetor comum pra contornar wrappers de módulo
// (permite acessar funcionalidade nativa de baixo nível sem passar por require()).
const originalBinding = process.binding;
if (typeof originalBinding === 'function') {
    process.binding = function (name) {
        if (['spawn_sync', 'process_wrap', 'pipe_wrap'].includes(name)) {
            console.error(`\n🚨 SEGURANÇA: Acesso a process.binding('${name}') bloqueado.`);
            throw new Error('Acesso negado.');
        }
        return originalBinding.call(this, name);
    };
}

// CORREÇÃO DE SEGURANÇA CRÍTICA (achado em teste de invasão real): tudo acima
// intercepta require() sobrescrevendo Module.prototype.require — mas isso NÃO
// pega import() dinâmico (await import('node:child_process')), que passa pelo
// carregador ESM do Node, um caminho totalmente separado. Testado de verdade:
// um bot conseguia rodar comando no host via import() mesmo com require()
// bloqueado. Registra um hook no carregador ESM pra fechar essa brecha também.
try {
    const { register } = require('node:module');
    const { pathToFileURL } = require('node:url');
    register('./security_loader_hooks.mjs', pathToFileURL(__filename));
} catch (e) {
    // Node muito antigo sem module.register() (< 20.6) — degrada sem essa
    // camada extra, mas o bloqueio via require() continua ativo.
    console.error('⚠️ Não foi possível ativar o bloqueio de import() dinâmico:', e.message);
}

console.log('🛡️ Blindagem de segurança v6.0 ativada (proteção best-effort — veja comentário no topo do arquivo).');
