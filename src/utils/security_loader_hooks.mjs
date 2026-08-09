/**
 * HOOK DO CARREGADOR ESM — bloqueia módulos banidos carregados via import()
 *
 * ACHADO EM TESTE DE INVASÃO REAL: security_wrapper.js intercepta
 * require('child_process') sobrescrevendo Module.prototype.require — mas
 * isso NÃO intercepta import() dinâmico (await import('node:child_process')),
 * que passa pelo carregador ESM do Node, um caminho completamente separado.
 * Um bot malicioso testado de verdade conseguiu rodar comandos no host desse
 * jeito, apesar do require() estar bloqueado. Este hook fecha essa brecha
 * interceptando o carregador ESM também.
 *
 * Roda numa thread separada do processo principal (sem acesso às variáveis
 * do security_wrapper.js), por isso a lista de módulos banidos é duplicada
 * aqui — se mudar uma, mude a outra também.
 */

const BANNED_MODULES = [
    'child_process',
    'cluster',
    'v8',
    'vm',
    'inspector',
    'repl',
];

function normalizeSpecifier(specifier) {
    return typeof specifier === 'string' && specifier.startsWith('node:')
        ? specifier.slice(5)
        : specifier;
}

export async function resolve(specifier, context, nextResolve) {
    if (BANNED_MODULES.includes(normalizeSpecifier(specifier))) {
        throw new Error(`Acesso negado ao módulo (via import): ${specifier}`);
    }
    return nextResolve(specifier, context);
}
