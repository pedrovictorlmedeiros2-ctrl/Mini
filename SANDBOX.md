# SANDBOX.md — Mecanismo de isolamento de bots

Este documento descreve o subsistema `src/managers/sandbox/` em detalhe:
o que cada backend isola de verdade, os requisitos do host, como
configurar, como rodar os testes, e — mais importante — **como verificar
que a sandbox está realmente ativa**, não apenas presumir.

---

## Visão geral

```
src/managers/sandbox/
├── SandboxManager.js         # decide qual backend usar (fail-closed)
├── capabilityDetector.js     # testa (não presume) o que o host suporta
├── bwrapSystemBinds.js       # monta binds de /usr,/bin,/lib pro bwrap
└── backends/
    ├── LinuxSandboxBackend.js   # isolamento real (bwrap + cgroup v2)
    └── ProcessSandboxBackend.js # reduzido (spawn direto, best-effort)
```

Nenhum outro módulo do sistema chama `bwrap`, `spawn()` de bot, ou lê
cgroup diretamente — tudo passa por `SandboxManager`.

---

## Backend `linux` — isolamento real

Ativado quando `capabilityDetector.detectCapabilities().linuxSandboxReady`
é `true`. Usa **bubblewrap (`bwrap`)** para namespaces + capabilities, e
**cgroup v2 direto** (sem depender de `systemd-run`) para limites de
recurso.

### O que é isolado, mecanismo por mecanismo

| Isolamento | Como | Confirmado (nesta sessão de desenvolvimento) |
|---|---|---|
| Filesystem | Mount namespace próprio (`--unshare-all`); só enxerga `/usr` (read-only), o binário do runtime (read-only), a pasta do bot (read-write) e `/proc`/`/dev`/`/tmp` isolados | ✅ symlink pra caminho não montado → `ENOENT` |
| Processos (PID) | PID namespace próprio | ✅ processo só vê a si mesmo (poucos PIDs em `/proc`), não a árvore do host |
| Usuário/privilégio | User namespace, uid/gid mapeados não-privilegiados | ✅ `id` mostra uid/gid não-root dentro |
| Capabilities | `--cap-drop ALL` | ✅ `CapInh/Prm/Eff/Bnd/Amb` todos zerados (não só CapEff) |
| Hostname (UTS) | Namespace próprio + `--hostname sandbox-<id>` | ✅ hostname interno ≠ hostname do host |
| IPC | Namespace próprio | ✅ shared memory criada fora não aparece dentro |
| Rede | `--unshare-net`, **sem veth** (ver limitação abaixo) | ✅ não alcança um servidor real do host |
| Memória | cgroup v2 `memory.max` + `memory.swap.max=0` | ⚠️ código testado, kernel-enforcement só validável em VPS real (ver abaixo) |
| Processos (cgroup) | cgroup v2 `pids.max` | ⚠️ idem |
| CPU | cgroup v2 `cpu.max` | ⚠️ idem |

> ⚠️ **Rede: limitação importante.** Nesta versão, o backend `linux`
> isola a rede **totalmente** (`--unshare-net` sem par `veth`) — o
> sandbox não alcança nada, **incluindo a internet**. Isso significa que
> bots Discord reais (que precisam conectar no gateway do Discord) **não
> vão conseguir se conectar** rodando neste backend, do jeito que ele está
> hoje. Rede restrita-mas-com-internet (via `veth` + `nftables`,
> permitindo saída pra internet e bloqueando RFC1918/`169.254.169.254`/
> localhost do host) é a peça que falta antes deste backend ser utilizável
> em produção de verdade — ver `SECURITY_LIMITATIONS.md`.

### Requisitos do host (Linux)

Todos os três, testados de verdade (não só "o binário existe") por
`capabilityDetector.js`:

1. **`bwrap` (bubblewrap) instalado e funcional**
   ```bash
   # Debian/Ubuntu
   apt install bubblewrap
   # Fedora
   dnf install bubblewrap
   # Arch
   pacman -S bubblewrap
   ```
2. **User namespaces sem restrição** — na maioria das distros já vem
   habilitado. Se `unshare --user --map-root-user true` falhar, confira:
   ```bash
   sysctl kernel.unprivileged_userns_clone   # deve ser 1 (Debian antigo costuma vir 0)
   sudo sysctl -w kernel.unprivileged_userns_clone=1
   ```
   Em hosts com AppArmor restringindo `unshare` (Ubuntu 24.04+ tem um perfil
   que pode bloquear isso pra alguns binários), pode ser necessário um
   perfil AppArmor específico pro `bwrap` — consulte a documentação da sua
   distro.
3. **cgroup v2 unificado, com delegação de escrita** no cgroup do processo
   que roda o Atlantic Host. Requisitos:
   - Kernel com cgroup v2 (`/sys/fs/cgroup/cgroup.controllers` existe e
     lista `memory`, `pids`, `cpu`).
   - O processo do Atlantic Host precisa ter permissão de **criar
     subdiretórios e escrever** dentro do seu próprio cgroup (delegação).
     Em hosts com `systemd`, isso normalmente já funciona pra serviços
     rodando sob um `systemd` unit (systemd delega automaticamente). Se
     estiver rodando fora de um unit systemd (ex: `pm2`, terminal direto),
     pode ser necessário mover o processo pra um cgroup delegado
     manualmente ou rodar via um unit systemd simples.

> Container de desenvolvimento aninhado (ex: onde este código foi escrito)
> tipicamente **não** tem delegação de cgroup v2 — isso é esperado e
> correto (não é um bug), só significa que esse ambiente específico não
> pode validar o backend `linux` de ponta a ponta. Um VPS Linux normal,
> iniciado normalmente com `systemd` como PID 1, deve ter tudo isso pronto
> por padrão na grande maioria das distros modernas (Ubuntu 22.04+, Debian
> 11+, Fedora recente).

### Backend `process` — reduzido (Windows e fallback documentado)

Usado sempre fora do Linux, ou (nunca automaticamente — só se você mesmo
escolher, ver `SECURITY_LIMITATIONS.md`) onde não há suporte a namespaces.
É **exatamente** o que o Atlantic Host já fazia antes desta versão: `spawn()`
direto do processo, com `security_wrapper.js` injetado (só bots Node) e
`cpulimit`/`nice` como limite de CPU quando disponíveis. `status().reduced`
é sempre `true` neste backend — nunca finge ser uma sandbox real.

---

## Configuração

Não há variável de ambiente pra "escolher" o backend — a escolha é sempre
automática e testada (`SandboxManager.decideBackend()`), de propósito: não
existe a opção de "forçar" o modo reduzido no Linux por engano.

O único ajuste indireto disponível hoje é o teto de PIDs por bot, com
fallback pra 100 se não configurado (`config.security.maxPidsPerBot`).

---

## Como rodar os testes

```bash
npm run test:sandboxCapability          # detecção de capacidades (sempre roda, reporta a verdade do host)
npm run test:linuxSandbox               # isolamento real via bwrap (pula partes que exigem cgroup v2 se não disponível)
npm run test:processSandbox             # backend reduzido
npm run test:sandboxManager             # decisão de backend + fail-closed
npm run test:processManagerIntegration  # startBot()/stopBot() de ponta a ponta, de verdade
```

Ou tudo de uma vez com `npm test` (auto-descobre `tests/*.test.js`).

Os testes que dependem de cgroup v2 real (limite de memória/PIDs mata o
processo de verdade) aparecem como `skip`, com o motivo explícito escrito
no próprio resultado do teste, quando o host não tem delegação — isso é
esperado num ambiente de desenvolvimento comum, e é a primeira coisa a
observar ao migrar pra um VPS real (se continuarem pulando lá, o host
precisa de configuração adicional, ver seção de requisitos acima).

---

## Como verificar se a sandbox está REALMENTE ativa

Não confie no fato de o código não ter lançado erro — confirme de verdade.

### 1. Pergunte ao detector, e leia o motivo se não estiver pronto

```bash
node -e "console.log(JSON.stringify(require('./src/managers/sandbox/capabilityDetector').detectCapabilities(), null, 2))"
```
Se `linuxSandboxReady` for `false`, o campo `linuxSandboxBlockedBy` lista
exatamente o que falta — não adivinhe, leia a lista.

### 2. Com um bot online, confira o backend reportado

Qualquer `sandbox.status()` (acessível via `activeProcesses` em
`processManager.js`) tem o campo `backend`: `'linux'` (real) ou `'process'`
(reduzido). Se o host é Linux e voce configurou tudo mas ainda vê
`'process'`, o `decideBackend()` decidiu que os requisitos não foram
atendidos — volte ao passo 1.

### 3. Confirme o cgroup existe de verdade, com os limites certos

O caminho exato depende de onde o processo do Atlantic Host está no
cgroup (varia por host — por isso `find` em vez de assumir um caminho
fixo):

```bash
find /sys/fs/cgroup -type d -name "atlantic-bots" 2>/dev/null
# dentro do diretório encontrado, um subdiretório por bot online:
ls /sys/fs/cgroup/.../atlantic-bots/
cat /sys/fs/cgroup/.../atlantic-bots/<id-do-bot>/memory.max
cat /sys/fs/cgroup/.../atlantic-bots/<id-do-bot>/pids.max
cat /sys/fs/cgroup/.../atlantic-bots/<id-do-bot>/memory.current   # uso real agora
```
Se o diretório não existir com um bot `'linux'` online, algo está errado —
não é esperado.

### 4. Confirme o isolamento de processo/rede na unha

⚠️ **Cuidado com qual PID checar.** O `bwrap` faz DOIS forks: o PID que o
Node rastreia (`sandbox.child.pid`, o que aparece em `activeProcesses`) é
um **processo supervisor externo**, que fica FORA de qualquer namespace
novo (ele existe pra implementar `--die-with-parent` e repassar sinais).
Quem entra de fato nos namespaces é um **processo filho** dele. Checar o
PID externo e concluir "não isolou" é um erro fácil de cometer — confirmado
na prática:

```bash
BWRAP_PID=<pid que activeProcesses/ps mostra>
INNER_PID=$(pgrep -P "$BWRAP_PID" | head -1)   # o filho, que é o que realmente importa

readlink /proc/self/ns/pid                      # namespace do Atlantic Host
readlink /proc/$BWRAP_PID/ns/pid                # IGUAL ao de cima — o supervisor não é isolado, isso é esperado
readlink /proc/$INNER_PID/ns/pid                # DIFERENTE dos dois de cima — aqui está o isolamento de verdade

sudo cat /proc/$INNER_PID/status | grep Cap     # deve ser tudo zero (CapInh/Prm/Eff/Bnd/Amb)
```

Se `readlink /proc/$INNER_PID/ns/pid` for **igual** ao do processo
principal do Atlantic Host, o isolamento não está de fato acontecendo —
isso nunca deveria acontecer com o backend `linux` funcionando
corretamente, e seria motivo de investigação imediata. Se for igual só no
PID *externo* (supervisor), está tudo certo — é o comportamento esperado
do bwrap.

Esta mesma distinção é o motivo pelo qual `monitorManager.js` usa
`sandbox.metrics()` (cgroup) em vez de `pidusage(pid externo)` pra medir
RAM/CPU de bots no backend `linux` — medir o PID externo mediria só o
supervisor (uso de recurso próximo de zero), não o processo real do bot.

### 5. Nunca confie só em "o bot está rodando" como prova de sandbox

Um bot pode estar rodando perfeitamente bem TANTO num sandbox real quanto
no modo reduzido — a única forma de saber qual é checando o `backend`
reportado (passo 2) e, se quiser certeza absoluta, os namespaces
(passo 4).
