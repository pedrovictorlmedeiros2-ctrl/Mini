# SECURITY_LIMITATIONS.md — Atlantic Host

O que **não** está protegido hoje, sem meias-palavras. Se algo não está
listado aqui como corrigido em `SECURITY_AUDIT.md` ou coberto em
`SANDBOX.md`, assuma que não está garantido.

---

## 1. Backend `process` (Windows, e qualquer não-Linux) — isolamento reduzido por definição

Este backend é `security_wrapper.js` + `spawn()` direto — exatamente o
que existia antes desta iniciativa de sandboxing. **Todos os achados
CRITICAL do `SECURITY_AUDIT.md` que afetam `security_wrapper.js`
continuam válidos e não corrigidos**, porque a natureza do problema
(proteção em JavaScript no mesmo processo) não tem correção real sem
isolamento de kernel — é por isso que o backend `linux` existe.

Concretamente, num bot rodando no backend `process`:

- `fs.openSync`/`fs.open` e vários outros métodos de `fs` não são
  interceptados → leitura/escrita arbitrária de qualquer arquivo que o
  processo do Atlantic Host consiga acessar, incluindo o `.env` real.
- `process.kill` não é interceptado → um bot pode derrubar o processo
  principal do Atlantic Host (e todos os outros bots) com
  `process.kill(process.ppid, 'SIGKILL')`.
- Nenhuma política de rede → acesso irrestrito a `net`/`http`/`dgram`/`dns`
  (SSRF, acesso a localhost/rede interna sem restrição).
- Qualquer pacote npm/pip instalado pelo bot pode conter código nativo
  compilado, que roda sem nenhuma checagem — o bloqueio de módulo é uma
  lista de nomes de built-ins do Node, não uma sandbox de verdade.
- Limite de CPU depende de `cpulimit`/`nice` estarem instalados no host —
  sem eles, nenhum limite de CPU é aplicado (Windows não tem `cpulimit`
  nativo).
- `fs.symlinkSync` continua não interceptado (achado M1, ainda em
  aberto) — um bot pode plantar um symlink dentro da própria pasta
  livremente. **O que isso conseguia fazer de mais grave (achado C5:
  exfiltrar arquivos do host via um Backup normal) já está corrigido** —
  `backupManager.js` monta o zip com `addLocalFolderSafe()`
  (`src/utils/safeZipFolder.js`), que nunca segue link simbólico ao
  caminhar a pasta do bot, então o symlink em si continua podendo ser
  criado, mas deixou de servir como vetor de exfiltração pelo backup.
  Esta correção vale pros dois backends (`linux` e `process`) — a
  vulnerabilidade estava no código de criação do backup em si, não no
  isolamento do processo do bot.

**Se o seu Atlantic Host roda em Windows hoje, isto é exatamente o nível
de proteção que você tem** — decisão consciente e confirmada em conversa,
não um descuido. Trate bots hospedados neste modo como teria tratado
antes desta iniciativa: com a mesma cautela de sempre.

---

## 2. Backend `linux` — o que falta, mesmo sendo isolamento real

### 2.1 Rede — ✅ implementada (veth ponto-a-ponto + nftables)

Corrigido. Cada bot ganha uma rede ponto-a-ponto própria (par `veth`,
sem bridge compartilhada — evita depender de criação de bridge, que se
mostrou bloqueada em pelo menos um tipo de ambiente containerizado
durante o desenvolvimento), endereçada dentro de `100.100.0.0/16`
(faixa CGNAT, RFC 6598 — escolhida de propósito por ser praticamente
nunca usada por LAN/VPC reais, ao contrário de `10.x`/`172.16.x`/
`192.168.x`, que têm chance real de colidir com a rede de verdade do
host). Ver `src/managers/sandbox/networkManager.js` e a seção de rede
em `SANDBOX.md`.

Mecanismo (resumo — detalhe completo no cabeçalho do arquivo): como
`bwrap` não tem uma flag pra "entrar" num network namespace
pré-existente, o processo é iniciado com `--block-fd`, que faz o
`bwrap` criar os namespaces e PARAR antes de rodar o comando real; o
`veth` é criado e movido pro namespace correto (via `nsenter` no PID
que de fato entrou nos namespaces — não o PID que o Node rastreia, que
é um supervisor externo, sem isolamento) NESSA janela, e só depois o
`bwrap` é desbloqueado.

Política aplicada via `nftables` (uma vez, no host):
- `POSTROUTING`: NAT (masquerade) — internet funciona de verdade.
- `FORWARD`: nega bot→bot e bot→RFC1918/link-local/loopback do host;
  aceita o resto (internet).
- `INPUT`: nega qualquer bot alcançando o próprio processo do Atlantic
  Host (ou qualquer outro serviço escutando no host).

**Validado ao vivo nesta sessão:** internet real alcançável de dentro
do sandbox (resposta HTTP de verdade); um "control-plane" fake do host
inalcançável pela mesma sub-rede; dois sandboxes diferentes,
simultâneos, confirmados **sem conseguir se alcançar um ao outro**
(teste com "vítima" escutando e "atacante" tentando conectar).

**Ainda não coberto:** filtragem por porta/protocolo (a política é só
por faixa de IP — um bot pode, em tese, tentar qualquer porta de
qualquer IP público, sem allowlist de destino) e rate limiting de
tráfego de rede por bot (nada impede um bot de saturar a banda de
saída do host, dentro do que o `cgroup` de CPU/RAM já não limita
diretamente — `nftables` tem suporte a isso, mas não foi configurado).

### 2.2 Sem seccomp

Decisão deliberada, não uma lacuna esquecida — ver comentário em
`LinuxSandboxBackend.js`. Filtrar syscall por syscall à mão é exatamente o
tipo de "inventar mecanismo de segurança" que foi pedido pra evitar.
Namespaces + zero capabilities cobrem a maioria dos vetores críticos, mas
uma sandbox com seccomp bem configurado (usando um perfil já auditado,
nunca escrito do zero aqui) seria mais forte. Fica como trabalho futuro.

### 2.3 Sem limite de disco

O pedido original (Fase 6) menciona limite de espaço em disco por bot
(ex: "500MB disk") — **isso não foi implementado**. Um bot pode encher o
disco disponível dentro da sua própria pasta sem limite algum vindo da
sandbox (só o que o filesystem do host já limitar naturalmente). Precisa
de quota de filesystem (ex: projeto XFS quota, ou um filesystem
loop-mounted de tamanho fixo por bot) — não implementado.

### 2.4 Sem limite de file descriptors

Também mencionado no pedido original (Fase 6), também não implementado.
`bwrap` não aplica `RLIMIT_NOFILE` por padrão, e não foi configurado aqui.

### 2.5 Métricas de CPU não alimentam o watchdog de aplicação

`monitorManager.js` usa `sandbox.metrics()` (cgroup `memory.current`) pra
RAM de bots no backend `linux`, mas **não** calcula uma % de CPU a partir
de `cpu.stat` (precisaria de amostragem por delta de tempo, não
implementado). Isso não é uma lacuna de segurança — o cgroup `cpu.max` já
limita CPU diretamente no kernel, independente do watchdog de aplicação —
mas significa que o painel/comandos que mostram "CPU: X%" não têm esse
número pra bots neste backend (fica em branco/null).

### 2.6 Falha parcial em `create()` — corrigida, mas não testada de ponta a ponta

O `LinuxSandboxBackend.create()` tem tratamento pra limpar o diretório de
cgroup se uma escrita de limite falhar no meio (ver commit da auditoria da
Fase 3). Essa correção foi validada por revisão de código, mas **não** tem
teste automatizado de regressão — simular a falha exigiria mockar
`fs.writeFileSync`/capacidades de um jeito que a classe hoje não permite
sem adicionar um ponto de injeção de dependência (funcionalidade nova além
do que foi pedido). Registrado como lacuna de teste conhecida, não como
bug.

### 2.7 Micro-race na atribuição ao cgroup

Entre o `spawn()` do `bwrap` e o `fs.writeFileSync` que move o PID pro
cgroup, existe uma janela de microssegundos onde o processo já está rodando
mas ainda não está sob o limite de recurso. Isso é uma limitação conhecida
e aceita — mesma ordem de grandeza do que ferramentas como Docker/runc têm
sem usar técnicas mais avançadas (`clone3()` com `CLONE_INTO_CGROUP`), que
não foram usadas aqui.

### 2.8 Validado neste ambiente de desenvolvimento vs. o que só um VPS real confirma

**Validado ao vivo, nesta sessão, neste container de desenvolvimento:**
filesystem isolado, PID namespace, UTS namespace, IPC namespace, zero
capabilities (as 5, não só CapEff), bloqueio de rede total, `--clearenv`,
rejeição de `id` malicioso, comportamento de `stop()`/`destroy()` sob
race real.

**Não validado aqui — requer cgroup v2 com delegação de escrita, ausente
neste container de desenvolvimento específico (mesma limitação
documentada desde a Fase 3):**
- Kernel realmente mata o processo ao estourar `memory.max`.
- Kernel realmente impede fork bomb via `pids.max`.
- Kernel realmente limita CPU via `cpu.max` sob carga sustentada.
- Comportamento de `create()`/`destroy()` sob uso real e prolongado
  (múltiplos bots, muitos restarts, ao longo de dias).

Um VPS Linux real, iniciado normalmente com `systemd` como PID 1
(a maioria das distros modernas), deveria ter tudo isso disponível — mas
**confirme com os comandos de `SANDBOX.md` → "como verificar se a sandbox
está realmente ativa" antes de confiar em produção**, não presuma.

---

## 3. Fora do escopo do SandboxManager inteiramente

- **Minecraft/Java**: continua com `spawn()` direto, sem nenhum backend de
  sandbox. Mesmos riscos de sempre (nenhum isolamento de kernel, nenhuma
  blindagem JS — Java não tem `security_wrapper.js` equivalente).
- **Docker**: `containerManager.js` continua funcionando por conta própria
  (isolamento real quando usado — rede dedicada por tenant, `--cap-drop
  ALL`, rootfs read-only, já auditado em ciclo anterior), mas **não foi
  encapsulado na mesma interface do SandboxManager**. `USE_CONTAINERS=true`
  continua sendo um caminho separado, não decidido por
  `SandboxManager.decideBackend()`.

---

## 4. Checklist do THREAT_MODEL.md — status atualizado

| O cliente NÃO pode conseguir | Backend `linux` | Backend `process` |
|---|---|---|
| Ler `.env` do Atlantic | ✅ (fora do filesystem montado) | ❌ (achado C1, não corrigido) |
| Ler tokens de outros bots | ✅ | ❌ |
| Acessar banco de outros tenants | ✅ | ❌ |
| Acessar filesystem de outros bots | ✅ | ❌ |
| Acessar/matar processos do Atlantic | ✅ (PID namespace) | ❌ (achado C2) |
| Acessar Docker socket | ✅ (não montado) | N/A (não aplicável nesse backend) |
| Acessar credenciais do sistema | ✅ | ❌ |
| Escalar privilégio (capabilities) | ✅ (todas zeradas) | ❌ (não removidas) |
| Acessar rede interna/SSRF | ✅ (veth ponto-a-ponto + nftables, ver 2.1) | ❌ (achado C3) |
| Acessar internet (bots reais precisam) | ✅ (via veth + nftables — bot↔bot, RFC1918, link-local e o próprio host ficam bloqueados; internet real passa, ver 2.1) | ✅ (sem restrição nenhuma, inclusive o que não deveria) |
| Fork bomb / exaustão de PID | ⚠️ não validado neste ambiente (cgroup `pids.max`) | ✅ (child_process bloqueado por nome) |
| Exaurir RAM do host | ⚠️ não validado neste ambiente (cgroup `memory.max`) | ⚠️ só watchdog reativo |
| Exaurir CPU do host | ⚠️ não validado neste ambiente (cgroup `cpu.max`) | ⚠️ só se `cpulimit`/`nice` disponíveis |
| Exaurir disco do host | ❌ (sem quota, nenhum backend) | ❌ |
| Exfiltrar host via Backup (symlink) | ✅ corrigido (achado C5 — `addLocalFolderSafe`, ver `SECURITY_AUDIT.md`) | ✅ idem |

---

## 5. Resumo executivo

**O sistema está pronto pra executar código de cliente não confiável de
verdade quando:** roda em Linux e `SandboxManager` reporta backend
`'linux'`. Isso agora inclui bots que precisam de acesso à internet real
(a maioria dos bots Discord) — a rede restrita (veth ponto-a-ponto +
nftables, ver 2.1) libera o tráfego pra internet enquanto bloqueia
bot↔bot, RFC1918/link-local e o próprio host. O que ainda falta nessa
frente (filtragem por porta/protocolo, rate limit de banda) é descrito
em 2.1 e não é bloqueador — é refinamento.

**O sistema continua no mesmo nível de proteção de antes desta iniciativa
quando:** roda em Windows, ou em Linux sem os requisitos do backend
`linux` — nesse caso, é o backend `process`, com todas as lacunas do
`SECURITY_AUDIT.md` ainda presentes.

**Corrigido em ambos os backends:** exfiltração via symlink na função de
Backup (achado C5) — `backupManager.js` agora monta o zip com
`addLocalFolderSafe()`, que nunca segue link simbólico. Correção
independente do backend de sandbox escolhido (o bug estava na criação do
backup em si, não no isolamento do processo do bot). M1 (`fs.symlinkSync`
livre) continua em aberto como item separado — a criação do symlink em si
ainda não é bloqueada, só deixou de servir como vetor de exfiltração pelo
backup.
