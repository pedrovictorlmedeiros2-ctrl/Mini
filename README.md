# 🤖 Atlantic Host — v8.6.0 Enterprise

Sistema completo de hospedagem e gestão de bots Discord, com segurança,
backup, monitoramento e deploy automatizado — tudo via comandos slash do
próprio bot Discord.

> Veja `IMPROVEMENTS.md` e `CHANGELOG-8.6.0.md` para o changelog detalhado.

---

## ✨ O que o projeto oferece

- Painel de hospedagem via Discord com comandos slash e UI completa.
- Gestão de bots e **Site/App**: start / stop / restart / logs / stats / arquivos / env / backup.
- Proteção de RAM do host (limites por plano + teto global).
- Watchdog com aviso antes de matar + DM ao dono.
- Deploy via Token, ZIP ou GitHub (+ Quick Deploy em thread privada).
- Isolamento de dependências Python com **virtualenv por bot**.
- Limites efetivos de CPU/RAM (override por bot + plano + default).
- Criptografia AES-256-GCM de tokens e backups.
- Watchdog, crash-loop protection, auto-restart inteligente.
- Fila de tarefas com concorrência e prioridade.
- Manutenção automática (logs, histórico, VACUUM).
- Docker (isolamento real, rede dedicada por tenant) + PM2 prontos para produção.

---

## 🚀 Instalação rápida

### Pré-requisitos

- Node.js 22 ou 24 (o banco de dados usa o módulo nativo `node:sqlite`, que não existe no Node 20 ou anterior)
- npm
- Git

### Passos

```bash
cd atlantic-host
npm install
cp .env.example .env
```

Edite o arquivo `.env` com valores reais (veja a seção de variáveis abaixo).

### Rodar localmente

```bash
node index.js
```

### Rodar testes

```bash
npm test              # roda a suíte inteira (node --test, auto-descobre tests/*.test.js)
npm run test:ci        # subconjunto que não precisa de token real do Discord (usado no CI)
npm run test:database
npm run test:crypto
npm run test:audit
npm run test:securityWrapper   # sobe processos node reais através da blindagem — mais lento
npm run test:containerManager  # precisa de Docker; pula graciosamente se não tiver
```

### Migrar tokens antigos

```bash
npm run migrate:tokens
```

---

## ⚙️ Variáveis de ambiente

O arquivo `.env` deve conter, no mínimo:

```env
BOT_TOKEN=seu_token_do_discord
CLIENT_ID=seu_client_id
OWNER_ID=seu_id_discord
ENCRYPTION_KEY=chave_segura_com_32_mais_caracteres
```

Outras opções úteis:

```env
GUILD_ID=seu_servidor_opcional
WEBHOOK_PORT=3000
GITHUB_WEBHOOK_SECRET=segredo_do_webhook
```

---

## 🐳 Docker

### Build e execução

```bash
docker compose up --build -d
```

O projeto já está preparado para montar os diretórios de bots, backups e logs.

### Isolamento entre bots

Quando `USE_CONTAINERS=true`, cada bot roda no seu próprio container:

- Rede dedicada `atlantic-host-tenants` (criada automaticamente, não a
  `bridge` padrão do Docker) com `com.docker.network.bridge.enable_icc=false`
  — o container de um cliente **não consegue** alcançar o de outro pela rede.
- `--cap-drop ALL` (remove todas as capabilities Linux), `--security-opt
  no-new-privileges`, rootfs `--read-only`, usuário non-root.
- Limites de `--pids-limit`, `--memory`/`--memory-swap` por bot/plano.
- Sem acesso ao socket do Docker (`/var/run/docker.sock`) de dentro do
  container — um bot não consegue criar/controlar outros containers.

Quando `USE_CONTAINERS=false` (padrão atual, sem Docker disponível), os bots
rodam como processos Node isolados por `security_wrapper.js` (bloqueia
`child_process`, `cluster`, `vm`, `inspector`, `process.binding`, e restringe
todo acesso a arquivo à pasta do próprio bot, com proteção contra escape via
link simbólico). Veja a seção Segurança para os testes que validam isso.

---

## 📁 Estrutura principal

```text
atlantic-host/
├── index.js
├── config.js
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── CHANGELOG-8.6.0.md
└── src/
    ├── commands/
    ├── database/
    ├── handlers/
    ├── managers/
    │   ├── fileManager.js       # explorer/CRUD de arquivos do bot, com proteção anti-traversal
    │   ├── containerManager.js  # isolamento Docker (rede dedicada por tenant)
    │   └── consoleManager.js    # buffer de log em memória + arquivo
    └── utils/
        └── security_wrapper.js  # sandbox do processo do bot (require hook + fs guard)
```

---

## 🔒 Segurança

- Tokens e backups armazenados com AES-256-GCM.
- Toda ação de bot passa por um único checkpoint de autorização
  (`canManageBot()`): dono, colaborador com permissão explícita, ou negado —
  sem caminho alternativo pra contornar essa checagem.
- Ambiente de execução isolado por pasta do bot, com proteção contra escape
  via `../` **e** via link simbólico (`fs.realpathSync` em toda resolução de
  caminho, tanto no gerenciador de arquivos quanto na sandbox do processo).
- Sandbox de processo (`security_wrapper.js`) bloqueia `child_process`,
  `cluster`, `vm`, `inspector`, `process.fork`, `process.binding` — inclusive
  via `import()` dinâmico, que contorna hook de `require` comum.
- Isolamento de rede entre containers de bots diferentes (rede dedicada,
  `enable_icc=false`), sem exposição do socket do Docker.
- Logs e status de saúde para observabilidade.

### Resultado do pentest de laboratório

Testado em ciclos de auditoria, sempre em ambiente isolado (bots/containers/
bancos de teste descartáveis — **nunca** contra o `hosting.db`/`.env` reais
de produção, exceto testes específicos que existem justamente pra provar que
o `.env` real não vaza):

**Vetores testados e cobertos por teste de regressão automatizado:**

1. **Path traversal clássico** (`../../../etc/passwd`) — bloqueado em
   `fileManager.js` e `security_wrapper.js`.
2. **Path traversal via link simbólico** — vetor mais sutil: um bot cria um
   symlink dentro da própria pasta apontando pra fora; `path.resolve()`
   sozinho não pega isso porque não segue links. Corrigido com resolução
   real (`fs.realpathSync`) em toda validação de caminho.
   - **Severidade:** Alta. **Componente:** `fileManager.js`,
     `security_wrapper.js`. **Como foi detectada:** teste de laboratório
     plantando um symlink real dentro da pasta de um bot malicioso.
     **Impacto:** leitura/escrita de qualquer arquivo do host acessível ao
     processo, incluindo o `.env` da plataforma. **Correção aplicada:**
     `fs.realpathSync()` com caminhada até o ancestral existente mais
     próximo, comparando o caminho real contra a pasta real do bot.
     **Teste após correção:** confirmado bloqueado contra um `.env` de
     laboratório com um segredo-marcador, e depois contra o `.env` real
     rodando o bot malicioso de verdade via `processManager.js`.
     **Resultado:** corrigido, com teste de regressão.
3. **Sandbox escape via módulos nativos** (`child_process`, `cluster`,
   `vm`, `inspector`, `process.fork`, `process.binding('spawn_sync')`,
   `import()` dinâmico) — todos bloqueados por `security_wrapper.js`,
   testado com processos Node reais (não mock).
4. **Exfiltração de `.env` real da plataforma** — teste crítico: bot
   malicioso real, hospedado pelo fluxo de produção, tentando ler o `.env`
   real do host. Bloqueado.
5. **Fork bomb / exaustão de recursos** — limitado por `--pids-limit` (modo
   container) e pelos limites de CPU/RAM por bot/plano já existentes no
   watchdog.
6. **Injeção de comando** — bots não têm acesso a `child_process`/`exec`
   dentro da sandbox; todo comando externo do próprio host (git, npm, etc.)
   roda via `execFile`/`spawn` com argumentos em array, nunca concatenando
   entrada do usuário numa string de shell.
7. **CVE de dependência** (`adm-zip` < 0.6.0, alta severidade — alocação de
   4GB de memória com ZIP malicioso) — corrigido via atualização de versão,
   zip-slip e zip-bomb re-testados depois.
8. **Timing attack em comparação de secret** — a checagem do secret
   compartilhado entre nodes (`workerAgent.js`) usava `!==` normal.
   Corrigido com `crypto.timingSafeEqual`.
9. **SSRF / SQL injection** — não há chamada de rede server-side controlada
   por entrada do usuário nem SQL montado por concatenação de string
   (`node:sqlite` com prepared statements em todo o código).

**Malware auto-replicante ou destrutivo real não foi criado nem testado** —
fora do escopo aceito por segurança, mesmo em laboratório isolado (risco real
de propagação acidental supera o valor do teste; os vetores de ataque acima
já cobrem os mesmos mecanismos de exploração que esse tipo de malware
usaria: escape de sandbox, exfiltração, exaustão de recursos, escalonamento
de privilégio).

**Riscos aceitos e documentados** (não corrigidos neste ciclo):

- `node-cron` (dependência transitiva `uuid`, severidade moderada): correção
  exigiria bump de versão semver-major com risco pouco claro no agendamento
  de produção; exploração prática baixa. Reavaliar no próximo ciclo.

---

## ✅ Status atual

- Banco funcionando (`node:sqlite`), criptografia validada.
- Isolamento de bot por sandbox de processo (`security_wrapper.js`) e,
  quando `USE_CONTAINERS=true`, por Docker com rede dedicada por tenant.
- Interação com a hospedagem é 100% via comandos slash do bot Discord (sem
  painel web — removido de propósito para reduzir superfície de ataque e
  manutenção).
- Migração de tokens antigos disponível (`npm run migrate:tokens`).
- Estrutura Docker pronta para uso em host compatível.
- Ver `CHANGELOG-8.6.0.md` para o histórico de versões.

---

## 📄 Licença

MIT
