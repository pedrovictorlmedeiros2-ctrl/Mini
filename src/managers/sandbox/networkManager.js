/**
 * NETWORK MANAGER — rede restrita-mas-com-internet pro LinuxSandboxBackend.
 *
 * Problema que isto resolve: `bwrap --unshare-net` sozinho isola a rede
 * TOTALMENTE (nem internet) — inútil pra bots Discord reais, que precisam
 * conectar no gateway do Discord. Este módulo dá a cada bot uma rede
 * ponto-a-ponto própria (veth), com saída pra internet via NAT, mas
 * bloqueada de alcançar: outros bots, a rede privada do host, endpoints de
 * metadata de cloud, e o próprio processo do Atlantic Host.
 *
 * MECANISMO (por que não é tão simples quanto parece):
 * bwrap não tem uma flag pra "entrar" num network namespace pré-existente
 * que a gente configure por fora — só `--unshare-net` (cria um novo,
 * anônimo, vazio) ou `--share-net` (usa o do host, sem isolamento nenhum).
 * A solução (confirmada funcionando ao vivo, mesma técnica usada por
 * ferramentas como o rootless Podman/slirp4netns) é:
 *   1. Iniciar o bwrap com `--block-fd N`, que faz ele criar os namespaces
 *      e então BLOQUEAR antes de executar o comando real, esperando 1
 *      byte no fd N.
 *   2. Encontrar o PID que de fato entrou no novo network namespace — não
 *      é o PID que o Node rastreia (esse é um processo supervisor externo
 *      do bwrap, que fica FORA de qualquer namespace novo por design,
 *      pra poder implementar --die-with-parent) — é um FILHO dele.
 *   3. Criar um par veth, mover o lado "bot" pro namespace desse PID via
 *      `ip link set <iface> netns <pid>`, e configurar IP/rota do lado de
 *      dentro via `nsenter --net=/proc/<pid>/ns/net -- ...`.
 *   4. Escrever no block-fd pra desbloquear o bwrap, que só ENTÃO executa
 *      o comando real — já com rede pronta.
 *
 * Rede escolhida: 100.100.0.0/16 (dentro de 100.64.0.0/10, RFC 6598 —
 * "Shared Address Space", reservado pra uso de operadoras/CGNAT e
 * praticamente nunca usado por redes privadas de verdade — evita colidir
 * com a rede real do host, ao contrário de usar 10.x.x.x/172.16.x.x/
 * 192.168.x.x, que TEM chance real de já estar em uso pela VPC/LAN onde o
 * Atlantic Host roda).
 */
const { execFileSync } = require('child_process');
const crypto = require('crypto');

const SUPERNET_BASE = process.env.SANDBOX_NETWORK_SUPERNET || '100.100';
const SUPERNET_CIDR = `${SUPERNET_BASE}.0.0/16`;
const NFT_TABLE = 'atlantic_sandbox';

// index (0-16383) -> { hostIp, botIp, vethHost, vethBot }
const allocations = new Map();
const usedIndices = new Set();

let hostSetupDone = false;

function sh(bin, args) {
    return execFileSync(bin, args, { timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function shIgnoreError(bin, args) {
    try { return sh(bin, args); } catch { return null; }
}

/**
 * Setup do host, uma vez só (idempotente — seguro chamar de novo). Ativa
 * ip_forward e cria as regras nftables que definem a política de rede:
 *  - POSTROUTING: NAT (masquerade) pra internet funcionar.
 *  - FORWARD: nega bot→bot e bot→redes privadas do host/metadata de cloud;
 *    aceita o resto (internet).
 *  - INPUT: nega qualquer bot alcançando o próprio processo do Atlantic
 *    Host (ou qualquer outra coisa escutando no host) via IP da rede de
 *    sandbox.
 */
function ensureHostNetworkSetup() {
    if (hostSetupDone) return;

    shIgnoreError('sysctl', ['-w', 'net.ipv4.ip_forward=1']);

    // Se a tabela já existe (processo reiniciado sem limpar), recria do
    // zero pra garantir que as regras estão exatamente como esperado —
    // nunca confia num estado parcial de uma execução anterior.
    shIgnoreError('nft', ['delete', 'table', 'inet', NFT_TABLE]);

    sh('nft', ['add', 'table', 'inet', NFT_TABLE]);

    sh('nft', ['add', 'chain', 'inet', NFT_TABLE, 'postrouting',
        '{ type nat hook postrouting priority 100 ; }']);
    sh('nft', ['add', 'rule', 'inet', NFT_TABLE, 'postrouting',
        'ip', 'saddr', SUPERNET_CIDR, 'masquerade']);

    sh('nft', ['add', 'chain', 'inet', NFT_TABLE, 'forward',
        '{ type filter hook forward priority 0 ; policy accept ; }']);
    // Bot -> bot: nunca.
    sh('nft', ['add', 'rule', 'inet', NFT_TABLE, 'forward',
        'ip', 'saddr', SUPERNET_CIDR, 'ip', 'daddr', SUPERNET_CIDR, 'drop']);
    // Bot -> outras redes privadas do host / link-local (inclui o
    // endpoint de metadata de cloud 169.254.169.254) / loopback: nunca.
    sh('nft', ['add', 'rule', 'inet', NFT_TABLE, 'forward',
        'ip', 'saddr', SUPERNET_CIDR, 'ip', 'daddr',
        '{ 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 127.0.0.0/8 }', 'drop']);
    // Todo o resto (internet): permitido — é a política padrão 'accept'
    // do chain, então não precisa de regra explícita.

    sh('nft', ['add', 'chain', 'inet', NFT_TABLE, 'input',
        '{ type filter hook input priority 0 ; policy accept ; }']);
    // Bot -> o próprio host (qualquer serviço escutando, incluindo o
    // control-plane do Atlantic Host): nunca.
    sh('nft', ['add', 'rule', 'inet', NFT_TABLE, 'input',
        'ip', 'saddr', SUPERNET_CIDR, 'drop']);

    hostSetupDone = true;
}

function indexToIps(index) {
    const thirdOctet = Math.floor(index / 64) % 256;
    const base = (index % 64) * 4;
    return {
        hostIp: `${SUPERNET_BASE}.${thirdOctet}.${base + 1}`,
        botIp: `${SUPERNET_BASE}.${thirdOctet}.${base + 2}`,
    };
}

function hashToIndex(id) {
    const hash = crypto.createHash('sha256').update(id).digest();
    return hash.readUInt16BE(0) % 16384;
}

/**
 * Aloca uma sub-rede /30 própria pra este bot (não cria nada no SO ainda —
 * só reserva o endereçamento). Chame antes de spawnar o bwrap, pra já ter
 * hostIp/botIp na hora de montar a rota default de dentro do sandbox.
 */
function allocateSubnet(botId) {
    ensureHostNetworkSetup();

    let index = hashToIndex(botId);
    let attempts = 0;
    while (usedIndices.has(index) && attempts < 16384) {
        index = (index + 1) % 16384;
        attempts++;
    }
    if (attempts >= 16384) {
        throw new Error('Sem sub-redes de sandbox livres (16384 em uso simultaneamente) — situação extrema, investigar vazamento de alocação.');
    }
    usedIndices.add(index);

    const { hostIp, botIp } = indexToIps(index);
    const indexHex = index.toString(16);
    const allocation = {
        botId,
        index,
        hostIp,
        botIp,
        prefix: 30,
        // Nomes de interface: limite de 15 caracteres (IFNAMSIZ-1) no
        // Linux — curtos de propósito, nunca derivados direto do botId
        // (que pode ser bem mais longo que 15 caracteres).
        vethHost: `vh${indexHex}`,
        vethBot: `vb${indexHex}`,
    };
    allocations.set(botId, allocation);
    return allocation;
}

/**
 * Cria o par veth, move o lado do bot pro network namespace do PID
 * indicado (o PID INTERNO do bwrap — ver comentário no topo do arquivo),
 * e configura IP/rota dos dois lados. Chame DEPOIS do bwrap ter sido
 * spawnado com --block-fd e ANTES de desbloquear o fd.
 */
function attachNetwork(allocation, innerPid) {
    const { vethHost, vethBot, hostIp, botIp, prefix } = allocation;

    sh('ip', ['link', 'add', vethHost, 'type', 'veth', 'peer', 'name', vethBot]);
    try {
        sh('ip', ['addr', 'add', `${hostIp}/${prefix}`, 'dev', vethHost]);
        sh('ip', ['link', 'set', vethHost, 'up']);
        sh('ip', ['link', 'set', vethBot, 'netns', String(innerPid)]);

        const nsenterNet = `--net=/proc/${innerPid}/ns/net`;
        sh('nsenter', [nsenterNet, 'ip', 'link', 'set', 'lo', 'up']);
        sh('nsenter', [nsenterNet, 'ip', 'addr', 'add', `${botIp}/${prefix}`, 'dev', vethBot]);
        sh('nsenter', [nsenterNet, 'ip', 'link', 'set', vethBot, 'up']);
        sh('nsenter', [nsenterNet, 'ip', 'route', 'add', 'default', 'via', hostIp]);
    } catch (err) {
        shIgnoreError('ip', ['link', 'del', vethHost]);
        throw new Error(`Falha ao configurar rede do sandbox: ${err.message}`);
    }
}

/**
 * Libera a interface do host (o kernel remove o par inteiro — o lado que
 * estava dentro do namespace do bot some junto) e a alocação de endereço.
 * Idempotente — seguro chamar mesmo se o processo já morreu e a interface
 * já sumiu sozinha.
 */
function detachNetwork(allocation) {
    if (!allocation) return;
    shIgnoreError('ip', ['link', 'del', allocation.vethHost]);
    usedIndices.delete(allocation.index);
    allocations.delete(allocation.botId);
}

module.exports = {
    SUPERNET_CIDR,
    ensureHostNetworkSetup,
    allocateSubnet,
    attachNetwork,
    detachNetwork,
};
