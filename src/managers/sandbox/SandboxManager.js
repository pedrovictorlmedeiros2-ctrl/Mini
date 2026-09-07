/**
 * SANDBOX MANAGER — ponto único de decisão de qual backend de isolamento
 * usar. O resto do sistema (processManager.js) NUNCA deve decidir isso
 * sozinho nem chamar bwrap/spawn diretamente — só fala com este módulo.
 *
 * Regra de seleção (fail-closed, sem exceção):
 *  - Windows → ProcessSandboxBackend (reduzido). É a única opção que
 *    existe no Windows — namespaces/cgroups não existem fora do Linux.
 *  - Linux, com bwrap + user namespaces + cgroup v2 delegado (todos os 3,
 *    testados de verdade por capabilityDetector, não só "o binário
 *    existe") → LinuxSandboxBackend (isolamento real de kernel).
 *  - Linux SEM os requisitos acima → RECUSA. Nunca cai pro
 *    ProcessSandboxBackend como fallback silencioso — se você queria
 *    isolamento de kernel e o host não pode oferecer, o bot não sobe até
 *    o host ser corrigido (instalar bwrap, delegar cgroup v2, etc).
 *
 * Esta regra foi explicitamente pedida e confirmada em conversa: Windows
 * continua operando com isolamento reduzido e documentado; Linux nunca
 * degrada silenciosamente.
 */
const { detectCapabilities } = require('./capabilityDetector');
const { LinuxSandboxBackend } = require('./backends/LinuxSandboxBackend');
const { ProcessSandboxBackend } = require('./backends/ProcessSandboxBackend');

/**
 * Decide qual backend usar neste host, sem efeitos colaterais (não cria
 * nada ainda — só decide). Chame isto ANTES de montar o comando/args
 * finais, porque a decisão afeta o que precisa ser injetado (ex:
 * security_wrapper.js só faz sentido pro backend 'process').
 *
 * @returns {{ name: 'linux'|'process'|null, reduced: boolean|null, reason: string|null }}
 */
function decideBackend() {
    if (process.platform !== 'linux') {
        return {
            name: 'process',
            reduced: true,
            reason: `Plataforma '${process.platform}' não tem namespaces/cgroups de kernel — isolamento reduzido (best-effort), não uma sandbox real. Único modo possível fora do Linux.`,
        };
    }

    const caps = detectCapabilities();
    if (caps.linuxSandboxReady) {
        return { name: 'linux', reduced: false, reason: null };
    }

    return {
        name: null,
        reduced: null,
        reason: `Sandbox Linux indisponível neste host — recusando iniciar (fail-closed, sem fallback para execução insegura). Motivo(s): ${caps.linuxSandboxBlockedBy.join(' | ')}`,
    };
}

/**
 * Cria e inicializa (create(), não start()) o backend decidido por
 * decideBackend(). Quem chama ainda precisa chamar sandbox.start().
 *
 * @param {ReturnType<typeof decideBackend>} decision
 * @param {object} spec - ver LinuxSandboxBackend/ProcessSandboxBackend
 * @returns {Promise<LinuxSandboxBackend|ProcessSandboxBackend>}
 */
async function createSandbox(decision, spec) {
    if (!decision.name) {
        throw new Error(decision.reason || 'Nenhum backend de sandbox disponível neste host.');
    }
    const Backend = decision.name === 'linux' ? LinuxSandboxBackend : ProcessSandboxBackend;
    const instance = new Backend(spec);
    await instance.create();
    return instance;
}

module.exports = {
    decideBackend,
    createSandbox,
    LinuxSandboxBackend,
    ProcessSandboxBackend,
};
