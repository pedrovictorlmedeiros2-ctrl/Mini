const test = require('node:test');
const assert = require('node:assert/strict');
const networkManager = require('../src/managers/sandbox/networkManager');
const { detectCapabilities } = require('../src/managers/sandbox/capabilityDetector');

const caps = detectCapabilities();
// allocateSubnet() chama ensureHostNetworkSetup() por baixo, que executa
// `nft add table` de verdade — sem CAP_NET_ADMIN isso lança, então estes
// testes precisam da mesma guarda condicional do resto da suíte (nunca
// assumir, sempre checar antes de rodar algo que mexe no SO).
const skipReason = (!caps.isLinux || !caps.nft.available)
    ? 'requer Linux + nftables funcional (CAP_NET_ADMIN) — não disponível neste ambiente'
    : false;

test('allocateSubnet() gera IPs distintos dentro do supernet reservado, e libera corretamente', { skip: skipReason }, () => {
    const allocs = [];
    for (let i = 0; i < 50; i++) {
        allocs.push(networkManager.allocateSubnet('test-alloc-' + i));
    }

    const ips = new Set();
    for (const a of allocs) {
        assert.ok(a.hostIp.startsWith('100.100.'), `hostIp deveria estar no supernet reservado, veio: ${a.hostIp}`);
        assert.ok(a.botIp.startsWith('100.100.'), `botIp deveria estar no supernet reservado, veio: ${a.botIp}`);
        assert.notEqual(a.hostIp, a.botIp);
        ips.add(a.hostIp);
        ips.add(a.botIp);
    }
    assert.equal(ips.size, 100, '50 alocações deveriam gerar 100 IPs únicos (2 por alocação), sem colisão');

    for (const a of allocs) networkManager.detachNetwork(a);
});

test('nomes de interface (vh<hex>/vb<hex>) nunca passam do limite de 15 caracteres do Linux (IFNAMSIZ-1)', { skip: skipReason }, () => {
    // Índice máximo possível (16383) — o pior caso pro tamanho do nome em hex.
    const a = networkManager.allocateSubnet('test-maxindex-nome-bem-longo-de-proposito-pra-provar-que-nao-influencia');
    assert.ok(a.vethHost.length <= 15, `vethHost muito longo: ${a.vethHost}`);
    assert.ok(a.vethBot.length <= 15, `vethBot muito longo: ${a.vethBot}`);
    networkManager.detachNetwork(a);
});

test('allocateSubnet() é determinístico o bastante pra não reusar um índice ainda em uso, mesmo com hash colidindo', { skip: skipReason }, () => {
    // Força uma colisão de verdade: aloca, e SEM liberar, aloca nomes que o
    // hash pode ou não repetir — o teste real é que, com muitas alocações
    // simultâneas, nunca duas recebem o MESMO endereço enquanto ambas
    // estiverem ativas (a garantia que realmente importa pra segurança:
    // dois bots nunca compartilham o mesmo IP ao mesmo tempo).
    const allocs = [];
    for (let i = 0; i < 200; i++) {
        allocs.push(networkManager.allocateSubnet('collision-test-' + i));
    }
    const seen = new Set();
    for (const a of allocs) {
        assert.ok(!seen.has(a.hostIp), `hostIp ${a.hostIp} reutilizado enquanto outra alocação ainda estava ativa`);
        seen.add(a.hostIp);
    }
    for (const a of allocs) networkManager.detachNetwork(a);
});

test('detachNetwork(null) não lança (chamado com segurança quando não há rede alocada)', () => {
    assert.doesNotThrow(() => networkManager.detachNetwork(null));
    assert.doesNotThrow(() => networkManager.detachNetwork(undefined));
});
