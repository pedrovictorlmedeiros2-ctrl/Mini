# Atlantic Host

Plataforma de hospedagem multi-node para bots e aplicações (Discord bots, apps
Node.js, serviços web genéricos), com painel do cliente, painel administrativo,
isolamento via Docker, provisionamento automático, backups, auditoria e
arquitetura preparada para escalar horizontalmente adicionando nodes.

## Arquitetura em uma imagem

```
                         CONTROL PLANE (packages/control-plane)
                         ───────────────────────────────────────
                         API REST + WebSocket · SQLite (WAL) · Fila de jobs
                         Scheduler · Reconciler · Auth · Billing · Auditoria
                                          │
                         ┌────────────────┼────────────────┐
                         │  WS /ws/agent  │  WS /ws/panel   │
                         ▼                                  ▼
                    NODE AGENT(S)                    PAINEL (React)
              (packages/node-agent)              (packages/panel)
                         │
                      Docker
                    (isolamento, limites
                     de CPU/RAM/PIDs)
                         │
                 containers dos clientes
```

- **Control Plane**: único ponto de entrada HTTP/WebSocket. Não executa
  processos de cliente diretamente — delega tudo aos nodes via RPC sobre
  WebSocket autenticado.
- **Node Agent**: daemon que roda em cada servidor físico/VM que hospeda
  containers. Fala com o Docker local, envia heartbeat/métricas, executa
  comandos (criar/iniciar/parar/remover container, arquivos, backups) e
  transmite logs em tempo real.
- **Painel**: SPA React única, com rotas para cliente e admin (controle de
  acesso por papel).

Consulte [`ARCHITECTURE.md`](./ARCHITECTURE.md) para o detalhamento de cada
subsistema (scheduler, fila, máquina de estados, reconciliação, segurança).

## Requisitos

- Node.js 20+
- Docker Engine rodando na máquina que executa o `node-agent` (o control-plane
  em si não precisa de Docker)

## Instalação

```bash
npm install   # instala todos os workspaces (control-plane, node-agent, panel, shared)
```

## Configuração

Cada serviço tem seu próprio `.env` (nunca commitado — veja `.gitignore`).
Copie os exemplos e preencha:

```bash
cp packages/control-plane/.env.example packages/control-plane/.env
cp packages/node-agent/.env.example packages/node-agent/.env
```

Gere segredos fortes para `JWT_SECRET`, `ENCRYPTION_KEY`, `NODE_AGENT_SECRET`
e `PAYMENT_WEBHOOK_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Defina `ADMIN_EMAIL`/`ADMIN_PASSWORD` no `.env` do control-plane para que um
usuário administrador seja criado automaticamente no primeiro boot.

## Rodando em desenvolvimento

Em três terminais separados:

```bash
# 1. Control plane (API + WebSocket + banco + fila + reconciler)
npm run dev:control-plane

# 2. Painel (Vite dev server, proxy para a API em localhost:4000)
npm run dev:panel

# 3. Pelo menos um node (precisa de Docker rodando). Primeiro registre o
#    node pelo painel admin (Nodes → Registrar node) ou via API:
curl -X POST http://localhost:4000/api/admin/nodes \
  -H "Authorization: Bearer <token-do-admin>" -H "Content-Type: application/json" \
  -d '{"name":"local-node-1","hostname":"localhost","region":"br-sp","ramMbTotal":4096,"cpuPercentTotal":400,"diskMbTotal":20480}'
# copie o `agentToken` retornado para packages/node-agent/.env (NODE_ID / NODE_TOKEN)

npm run dev:node-agent
```

Abra `http://localhost:5173`.

## Testes

```bash
npm test   # roda a suíte do control-plane e do node-agent (node --test)
```

Os testes cobrem, entre outros: isolamento entre tenants (IDOR), rejeição de
path traversal (control-plane e node-agent, incluindo escape via symlink),
idempotência da fila de jobs, reserva atômica de recursos do scheduler e a
máquina de estados de servidores.

## Fluxo de ponta a ponta

```
Cliente cria conta → escolhe plano → cria pedido (PENDING)
   → pagamento aprovado (webhook assinado ou aprovação manual do admin)
   → job PROVISION_SERVER: scheduler reserva um node → agente cria o container
     com limites de CPU/RAM/PIDs → servidor fica STOPPED
   → cliente inicia o servidor, acompanha console em tempo real, gerencia
     arquivos, variáveis de ambiente, backups e domínios pelo painel
```

## Segurança — pontos que valem destacar

- Toda rota que carrega um recurso por id usa um "chokepoint" único de
  ownership (`getServerOwnedBy`, `getOrderOwnedBy`, ...): pertence a outro
  usuário → **404**, nunca 403 (não confirma existência).
- Senhas com bcrypt (12 rounds); variáveis de ambiente sensíveis (tokens,
  senhas) são criptografadas em repouso (AES-256-GCM) e mascaradas no painel.
- Bloquear um usuário incrementa `token_version`, invalidando **imediatamente**
  todos os tokens JWT já emitidos, sem precisar de uma blacklist.
- Webhook de pagamento valida assinatura HMAC com `crypto.timingSafeEqual` e é
  idempotente por `(provider, ref)` — reentregas/duplicatas não reprovisionam.
- Path traversal é bloqueado em duas camadas independentes: uma checagem
  sintática no control-plane (antes de sequer contactar o node) e uma
  checagem autoritativa no node-agent que resolve symlinks (`fs.realpathSync`)
  para impedir escape via link simbólico plantado dentro do volume do cliente.
- Containers rodam com `--cap-drop ALL`, `no-new-privileges`, limites reais de
  memória/CPU/PIDs do Docker, e todo comando destrutivo do agente confere um
  label `atlantic.managed=true` antes de agir — o agente nunca toca em
  containers que não criou.

## Limitações conhecidas (honestas, não escondidas)

- **Cota de disco** é reportada via `df` do volume, mas não é um *hard limit*
  do kernel (exigiria quotas XFS/pquota por container, não garantidas em todo
  host) — RAM e CPU, sim, são limites reais aplicados pelo Docker.
- **Domínios**: o modelo de dados e o fluxo de verificação existem, mas não há
  integração real com um provedor de DNS nem reverse-proxy/SSL automático
  (não há infraestrutura de DNS/ACME disponível neste ambiente) — fica
  registrado para configuração manual.
- **Failover automático entre nodes** não é feito para o volume de um
  servidor: se um node cai, os servidores nele ficam indisponíveis até o node
  voltar (o volume só existe naquele disco). Implementar isso de verdade exige
  armazenamento replicado (ex.: um storage distribuído) — inventar uma
  recriação "mágica" em outro node sem os dados reais seria pior que não
  fazer nada.
- Editor de arquivos no painel é limitado a 2&nbsp;MB por arquivo (edição
  inline); upload/download de arquivos maiores ainda não tem um caminho HTTP
  dedicado no agente (hoje passa pela RPC WebSocket, pensada para operações
  pequenas/rápidas).

## Estrutura do monorepo

```
packages/
  shared/          constantes e máquina de estados compartilhadas (planos, status)
  control-plane/   API, banco (SQLite/WAL), fila, scheduler, reconciler, WS
  node-agent/      daemon por node: Docker, arquivos, backups, logs, métricas
  panel/           SPA React (painel do cliente + painel admin)
```
