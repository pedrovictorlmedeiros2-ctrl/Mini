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
- `fs.symlinkSync` não é interceptado — a função de Backup
  (`backupManager.js`, achado C5) pode exfiltrar arquivos do host se um
  bot plantar um symlink e o dono pedir um backup — **este achado
  específico ainda não foi corrigido no código do backup**, só documentado.

**Se o seu Atlantic Host roda em Windows hoje, isto é exatamente o nível
de proteção que você tem** — decisão consciente e confirmada em conversa,
não um descuido. Trate bots hospedados neste modo como teria tratado
antes desta iniciativa: com a mesma cautela de sempre.

---

## 2. Backend `linux` — o que falta, mesmo sendo isolamento real

### 2.1 Rede: hoje é tudo-ou-nada (bloqueador de uso em produção)

`--unshare-net` sem par `veth` bloqueia **toda** rede, incluindo internet.
Um bot Discord real (que precisa conectar no gateway do Discord via
WebSocket) **não vai conseguir se conectar** rodando neste backend, do
jeito que ele está hoje. Antes de usar este backend em produção de
verdade para bots que precisam de internet, falta implementar:

- Namespace de rede dedicado por bot + par `veth`.
- Regras `nftables` no lado do host: `DROP` para RFC1918 (redes privadas —
  impede alcançar outros bots/serviços internos), `DROP` para
  `169.254.169.254` (metadata de cloud), `ALLOW` para o resto (internet).

Sem isso, o backend `linux` só é utilizável hoje para bots que **não**
precisam de rede (raro na prática) ou para validação/teste do isolamento
em si.

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
| Acessar rede interna/SSRF | ✅ (rede totalmente isolada) | ❌ (achado C3) |
| Acessar internet (bots reais precisam) | ❌ (ainda não implementado — ver 2.1) | ✅ (sem restrição nenhuma, inclusive o que não deveria) |
| Fork bomb / exaustão de PID | ⚠️ não validado neste ambiente (cgroup `pids.max`) | ✅ (child_process bloqueado por nome) |
| Exaurir RAM do host | ⚠️ não validado neste ambiente (cgroup `memory.max`) | ⚠️ só watchdog reativo |
| Exaurir CPU do host | ⚠️ não validado neste ambiente (cgroup `cpu.max`) | ⚠️ só se `cpulimit`/`nice` disponíveis |
| Exaurir disco do host | ❌ (sem quota, nenhum backend) | ❌ |
| Exfiltrar host via Backup (symlink) | ⚠️ ainda explorável (achado C5, não corrigido) | ⚠️ idem |

---

## 5. Resumo executivo

**O sistema está pronto pra executar código de cliente não confiável de
verdade quando:** roda em Linux, `SandboxManager` reporta backend
`'linux'`, e o bot **não precisa de acesso à internet** (a maioria dos
bots Discord reais precisa — portanto, na prática, **ainda não está
pronto pra esse caso de uso até a rede restrita-mas-com-internet ser
implementada**, ver 2.1).

**O sistema continua no mesmo nível de proteção de antes desta iniciativa
quando:** roda em Windows, ou em Linux sem os requisitos do backend
`linux` — nesse caso, é o backend `process`, com todas as lacunas do
`SECURITY_AUDIT.md` ainda presentes.

**Não corrigido em nenhum backend:** exfiltração via símlink na função de
Backup (achado C5) — item isolado, correção pequena e ainda pendente,
independente do backend de sandbox escolhido.
