# Deploy persistente — Atlantic Host em produção

Este documento cobre como rodar o Atlantic Host fora do VS Code, de forma
persistente (sobrevive a fechar o terminal, crash e reboot da VPS), com
**systemd como opção principal** e **PM2 como alternativa de
desenvolvimento/fallback**.

Nada aqui é executado automaticamente por este repositório — os comandos
abaixo precisam ser rodados manualmente, por você, na sua VPS, com
autorização explícita (instalar serviço, abrir porta de firewall etc. são
decisões operacionais, não deste código).

---

## 1. Pré-requisitos

- Linux (Ubuntu 22.04+/Debian 11+/Fedora recente — qualquer distro com
  systemd como PID 1 e kernel razoavelmente recente).
- Node.js **22 ou 24** (o banco usa `node:sqlite` nativo — outras versões
  não funcionam, `index.js` recusa subir e explica isso na mensagem).
- Para hospedar bots com isolamento real (backend `linux` do
  `SandboxManager`): `bubblewrap` (`bwrap`), `nftables`, `iproute2`,
  cgroup v2 **com delegação de escrita** pro usuário que roda o serviço —
  ver `SANDBOX.md` pros requisitos exatos e como confirmar cada um.
- Um usuário de sistema dedicado, sem privilégio de root (ver passo 3).

Confirme a versão do Node antes de tudo:
```bash
node --version   # precisa começar com v22 ou v24
```

---

## 2. Preparar o diretório e o `.env`

```bash
sudo mkdir -p /opt/atlantic-host
sudo chown "$USER" /opt/atlantic-host
git clone <url-do-seu-fork-ou-repo> /opt/atlantic-host
cd /opt/atlantic-host
npm ci --omit=dev
cp .env.example .env
chmod 600 .env
# edite .env com os valores REAIS: BOT_TOKEN, CLIENT_ID, OWNER_ID,
# ENCRYPTION_KEY (>=16 caracteres, gere uma chave forte só pra isso),
# NODE_ENV=production (já vem assim no .env.example).
```

`ENCRYPTION_KEY` e o `BOT_TOKEN`/demais tokens **nunca** vão em nenhum
arquivo de serviço (systemd unit ou `ecosystem.config.js`) — só no
`.env`, que o próprio `index.js` carrega sozinho (`dotenv`), com
permissão restrita (`600`) e dono correto.

---

## 3. Usuário dedicado (nunca rodar como root)

```bash
sudo useradd --system --home /opt/atlantic-host --shell /usr/sbin/nologin atlantic-host
sudo chown -R atlantic-host:atlantic-host /opt/atlantic-host
```

Se o backend `linux` (bwrap + cgroup v2) for usado, esse usuário precisa
de delegação de cgroup v2 — ver `SANDBOX.md`, seção de requisitos.

---

## 4. Instalar o serviço systemd (produção — opção principal)

```bash
sudo cp deploy/atlantic-host.service /etc/systemd/system/atlantic-host.service
# Edite /etc/systemd/system/atlantic-host.service e confirme:
#   - WorkingDirectory aponta pro checkout real (/opt/atlantic-host, se
#     seguiu o passo 2 como está);
#   - ExecStart aponta pro node certo (`which node`, rode como o usuário
#     atlantic-host: `sudo -u atlantic-host which node`);
#   - User/Group já são atlantic-host (criado no passo 3).
sudo systemctl daemon-reload
sudo systemctl enable atlantic-host       # sobrevive a reboot
sudo systemctl start atlantic-host
```

### Comandos do dia a dia

```bash
sudo systemctl status atlantic-host       # estado atual (running/failed/etc)
sudo systemctl restart atlantic-host      # reinício supervisionado
sudo systemctl stop atlantic-host         # parada deliberada (NÃO reinicia sozinho depois — Restart=on-failure)
journalctl -u atlantic-host -f            # logs em tempo real
journalctl -u atlantic-host --since "1 hour ago"
journalctl -u atlantic-host -p err        # só erros
```

### Por que systemd em vez de PM2 em produção

- Já vem em qualquer VPS Linux moderna — nada a instalar globalmente.
- Sobrevive a reboot da VPS sem passo extra (PM2 exige `pm2 startup` +
  `pm2 save`, e some se esquecido).
- Logs vão pro `journald` do próprio SO, com rotação e retenção
  configuráveis centralmente (`/etc/systemd/journald.conf` —
  `SystemMaxUse=`, `RuntimeMaxUse=`), sem depender de um módulo externo.
- `Restart=on-failure` + `StartLimitBurst=10`/`StartLimitIntervalSec=300`
  dão um disjuntor de crash loop no nível do supervisor, complementando
  (não substituindo) o de `processManager.js`.

---

## 5. Alternativa: PM2 (desenvolvimento ou fallback operacional)

Use isto se não tiver acesso a systemd (alguns PaaS/containers
restritos) ou estiver testando localmente.

```bash
npm install -g pm2
pm2 install pm2-logrotate     # SEM ISTO, os logs do PM2 crescem sem limite
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14

npm run pm2:start             # pm2 start ecosystem.config.js --env production
pm2 save                      # grava a lista de processos atual
pm2 startup                   # imprime o comando (varia por SO) pra sobreviver a reboot — rode o que ele mandar
```

Comandos do dia a dia: `npm run pm2:status`, `npm run pm2:logs`,
`npm run pm2:restart`, `npm run pm2:stop`.

**Sem `pm2 startup` + `pm2 save`, o PM2 NÃO sobrevive a um reboot da
VPS** — é o erro mais comum desse caminho.

---

## 6. Validar de verdade que sobrevive ao fechar o terminal/VS Code

Não assuma — confirme:

```bash
# 1. Suba o serviço (systemd ou PM2, como acima).
# 2. Confirme que está rodando:
curl -s http://localhost:${HEALTH_PORT:-3001}/health | head -c 300
# 3. Feche o terminal/janela do VS Code onde você rodou os comandos acima
#    (ou, se estiver numa sessão SSH, feche a sessão inteira: `exit`).
# 4. Numa OUTRA sessão/terminal, alguns segundos depois:
curl -s http://localhost:${HEALTH_PORT:-3001}/health | head -c 300
# Se responder normalmente, o processo sobreviveu — confirmado.
```

Pra confirmar reinício após crash:
```bash
# Ache o PID real do processo (não do supervisor):
sudo systemctl show -p MainPID atlantic-host
kill -9 <PID>            # mata "de propósito", simulando um crash
sleep 6
sudo systemctl status atlantic-host   # deveria mostrar "active (running)" de novo, com um PID novo
```

Pra confirmar reinício após reboot (só faça isso com autorização — reinicia a VPS de verdade):
```bash
sudo reboot
# depois que a VPS voltar:
sudo systemctl status atlantic-host   # deveria estar "active (running)" sem nenhum comando manual
```

---

## 7. Diagnóstico

| O que checar | Comando |
|---|---|
| Estado do serviço | `systemctl status atlantic-host` |
| Logs recentes | `journalctl -u atlantic-host -n 200` |
| Health geral + readiness | `curl -s localhost:3001/health \| jq` |
| Só o readiness gate (READY/DEGRADED/BLOCKED) | `curl -s localhost:3001/ready \| jq` — HTTP 503 se BLOCKED |
| Métricas Prometheus | `curl -s localhost:3001/metrics` |
| Lock de instância (deveria existir 1 arquivo, com o PID atual) | `node -e "console.log(require('./src/database/database').dbPath)"` pra achar o caminho do banco, depois `cat <caminho>.lock` |
| Incidentes de segurança recentes (Kamikaze) | consultar a tabela `incidents`/`audit_log` no banco, ou o painel admin |

Se `/ready` responder **BLOCKED**: o bot de controle do Discord continua
respondendo normalmente, mas **nenhum bot hospedado inicia e nenhum
provisionamento roda** até o motivo listado em `blockedReasons` ser
corrigido (ex.: diretório sem permissão de escrita, ou — com
`NODE_ENV=production`/`REQUIRE_LINUX_SANDBOX=true` — isolamento Linux
forte indisponível neste host; ver `SANDBOX.md`). Isso é fail-closed
intencional, não um bug.

---

## 8. Rollback

```bash
cd /opt/atlantic-host
sudo systemctl stop atlantic-host
git log --oneline -10          # ache o commit/tag bom conhecido
git checkout <commit-ou-tag>   # ou: git reset --hard <commit> se tiver certeza que não há trabalho local
npm ci --omit=dev              # dependências podem ter mudado entre versões
sudo systemctl start atlantic-host
systemctl status atlantic-host
```

Se o rollback envolver uma migração de banco incompatível, restaure o
backup do banco (próximo passo) **antes** de subir a versão antiga — o
schema mais novo pode ter colunas/tabelas que a versão antiga do código
não espera (embora as migrações deste projeto sejam aditivas, via
`ALTER TABLE ... ADD COLUMN`, o que normalmente é seguro voltar).

---

## 9. Backup do banco (SQLite)

O banco é um único arquivo (`src/database/hosting.db` por padrão, ou
`HOSTING_DB_PATH` se configurado). Rodando em WAL (já configurado em
`sqliteCompat.js`), a forma mais simples e segura de garantir um backup
consistente é parar o serviço antes de copiar:

```bash
sudo systemctl stop atlantic-host
BACKUP_NAME="hosting-$(date +%Y%m%d-%H%M%S).db"
cp /opt/atlantic-host/src/database/hosting.db "/opt/backups/$BACKUP_NAME"
cp /opt/atlantic-host/src/database/hosting.db-wal "/opt/backups/$BACKUP_NAME-wal" 2>/dev/null || true
sudo systemctl start atlantic-host
```

Isto é **separado** dos backups de código/arquivos de cada bot hospedado
(já cobertos por `backupManager.js`/Kamikaze) — este passo é
especificamente o banco de controle da própria plataforma (usuários,
bots, incidentes, auditoria).

---

## 10. O que NÃO fazer

- Não rodar duas instâncias apontando pro mesmo `HOSTING_DB_PATH` — o
  lock de instância (`src/utils/instanceLock.js`) recusa a segunda, mas
  a primeira linha de defesa é operacional: nunca configure dois
  serviços/unidades pro mesmo banco.
- Não editar arquivos de unit/ecosystem pra colocar segredos direto —
  tudo vai no `.env` (permissão 600).
- Não forçar `REQUIRE_LINUX_SANDBOX=false` em produção só pra "destravar"
  um host BLOCKED — isso reintroduz exatamente o backend reduzido que o
  gate existe pra evitar. Corrija a causa raiz (ver `blockedReasons` em
  `/ready`) antes.
