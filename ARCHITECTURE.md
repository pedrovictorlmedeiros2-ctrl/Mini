# Arquitetura — Atlantic Host

## Visão geral

```
                                CONTROL PLANE
        ┌──────────────────────────────────────────────────────────┐
        │  Express API (/api/*)         WebSocket (/ws/agent,       │
        │  ├─ auth, plans, orders,       /ws/panel)                 │
        │  │  servers, files, admin      ├─ agentServer.js          │
        │  ├─ payments webhook (HMAC)    │  (RPC para nodes)        │
        │  └─ middleware: auth, rate     └─ panelServer.js          │
        │     limit, validação (zod)        (push para o painel)   │
        │                                                            │
        │  services/                     queue/                     │
        │  ├─ scheduler.js  (escolha     ├─ queue.js (worker loop,  │
        │  │  de node + reserva atômica) │   concorrência, retry)   │
        │  ├─ provisioning.js (fluxo     └─ handlers.js (mapeia     │
        │  │  completo com rollback)         JobType → serviço)     │
        │  ├─ serverLifecycle.js                                    │
        │  ├─ serverStateMachine.js      repositories/ (SQLite,     │
        │  ├─ reconciler.js               prepared statements)      │
        │  └─ agentRegistry.js (RPC)                                │
        └──────────────────────────────────────────────────────────┘
                         │ WebSocket (JSON RPC + heartbeat + logs)
                         ▼
                    NODE AGENT (1 processo por servidor físico/VM)
        ┌──────────────────────────────────────────────────────────┐
        │  agent.js — conecta, reconecta com backoff, despacha       │
        │  comandos para: docker.js · files.js · backup.js ·         │
        │  logStreams.js · lib/systemStats.js                        │
        └──────────────────────────────────────────────────────────┘
                         │
                      Docker Engine (dockerode)
                         │
                containers com label atlantic.managed=true
```

## Por que Control Plane e Node Agent são processos separados

O Control Plane nunca deve ser o gargalo nem o ponto único de falha para a
*execução* dos bots — ele decide e coordena, mas quem roda os containers é o
node. Isso significa:

- Adicionar capacidade = subir um novo node-agent e registrá-lo (nenhuma
  mudança de código no control plane).
- Uma instabilidade de Docker/host afeta só os servidores daquele node, não a
  API, o painel ou os outros nodes.
- O control plane pode ficar sem estado pesado por node (só cache leve de
  conexão + métricas do último heartbeat), então múltiplas réplicas do
  control plane são viáveis no futuro sem reprojetar nada — hoje ele já não
  guarda nenhum estado só-em-memória que não possa ser reconstruído do banco
  (a única exceção documentada é o mapa de conexões WebSocket ativas, que é
  inerentemente por-processo).

## Protocolo Control Plane ↔ Node Agent

Um único WebSocket por node, autenticado por um token opaco (gerado uma vez
no registro do node, guardado como hash SHA-256 no banco — nunca em texto
puro). Duas famílias de mensagem:

- **Comando/resposta** (`agentRegistry.sendCommand`): o control plane envia
  `{type:"command", id, action, payload}` e aguarda `{type:"result", id, ok,
  data|error}` com timeout. Usado para tudo que tem um resultado imediato:
  criar/iniciar/parar/remover container, operações de arquivo, stats,
  backup/restore.
- **Fire-and-forget** (`WATCH_LOGS`/`UNWATCH_LOGS`, heartbeat, `log`,
  `exited`): não há resposta correlacionada — são eventos/streams contínuos.

Por que não HTTP simples do control plane para o node? Porque o node pode
estar atrás de NAT/rede privada e é o node quem inicia a conexão (outbound),
não o control plane — o mesmo padrão usado por praticamente todo agente de
infraestrutura (Kubernetes kubelet faz o oposto por causa do modelo de rede
do cluster; aqui o modelo é "muitos nodes possivelmente em datacenters
diferentes falando com um control plane central", mais parecido com agentes
tipo Prometheus remote-write/Consul agent).

## Scheduler e reserva de recursos

`services/scheduler.js` pontua nodes ativos e **conectados** por RAM/CPU/disco
livres (ponderado, com leve penalidade por densidade de containers) e tenta
reservar no melhor candidato. A reserva em si é uma única query SQL
`UPDATE ... WHERE ram_reservado + X <= ram_total AND ...`
(`repositories/nodes.js#reserveResources`) — atômica por natureza do SQLite
(um único statement, sem race entre "ler capacidade" e "decidir reservar").
Se a reserva falhar (outra requisição venceu a corrida), o scheduler tenta o
próximo candidato da lista.

## Máquina de estados dos servidores

Definida uma única vez em `packages/shared/src/states.js`
(`SERVER_TRANSITIONS`) e aplicada em um único chokepoint,
`services/serverStateMachine.js#transitionServer` — nenhum outro lugar do
código escreve diretamente `servers.status`. Transição inválida lança
`InvalidTransitionError` (não é retentável). Isso é o que impede estados
impossíveis tipo "STOPPED → RUNNING" sem passar por STARTING.

## Fila de jobs

Fila durável (tabela `jobs`, sobrevive a restart do control plane) com:

- **Concorrência limitada** (`QUEUE_CONCURRENCY`, default 5) — não processa
  500 jobs pesados simultaneamente só porque chegaram juntos.
- **Retry com backoff exponencial** (capado em 60s) baseado em
  `job.attempts`/`job.max_attempts`.
- **Idempotência**: `idempotency_key` único; uma chamada repetida enquanto o
  job está `QUEUED`/`RUNNING`/`SUCCEEDED` retorna o job existente em vez de
  duplicar trabalho. Um job que terminou `FAILED` **libera** sua chave (uma
  regressão real encontrada e corrigida durante o desenvolvimento — sem isso,
  uma primeira tentativa de exclusão que falhasse bloquearia *para sempre*
  qualquer nova tentativa do usuário).
- **Jobs órfãos**: se o processo morre com jobs `RUNNING`, o próximo boot os
  devolve para `QUEUED` (`requeueOrphanedJobs`).

## Provisionamento com rollback

`services/provisioning.js#provisionServer`:

1. Reserva recursos no node escolhido (nada é criado ainda — se falhar aqui,
   é seguro tentar de novo automaticamente).
2. Cria a linha do servidor (`CREATING` → `INSTALLING`).
3. Pede ao node para criar o container.
4. Sucesso → `STOPPED`, pedido marcado `PROVISIONED`.
5. Qualquer falha depois do passo 2 → libera a reserva, tenta remover o
   container parcialmente criado (melhor esforço), marca o servidor `ERROR` e
   **não permite mais retry automático** (retentar do zero criaria uma
   segunda linha de servidor para o mesmo pedido) — fica para o usuário
   excluir/tentar de novo explicitamente. Só a falha "sem capacidade" (antes
   de qualquer criação) é retentável automaticamente pela fila.

## Reconciliação

`services/reconciler.js`, rodando em intervalo (`RECONCILE_INTERVAL_MS`):

- Node sem heartbeat dentro do timeout → `OFFLINE`.
- Servidor preso num estado transitório (`STARTING`, `DELETING`, ...) por
  tempo demais → `ERROR` (visível para intervenção, nunca escondido).
- Pergunta a cada node conectado sua lista real de containers
  (`LIST_CONTAINERS`, filtrada por label): container sem servidor
  correspondente no banco → removido (é órfão por definição); servidor
  `RUNNING` no banco cujo container sumiu/morreu → tratado como crash
  inesperado e entra no fluxo de auto-heal com backoff e limite de tentativas.
- **Não inventa failover**: se um node morre, seus servidores ficam
  indisponíveis até ele voltar — o volume dos dados só existe naquele disco.

## Segurança multi-tenant

Todo endpoint que opera sobre um servidor específico passa por
`loadServer` (`routes/servers.js`), que busca por
`getServerOwnedBy(id, userId)` para usuários comuns (admins usam
`getServerById` sem filtro de dono). Um recurso de outro usuário sempre
resulta em **404**, nunca 403 — não confirmamos nem a existência do recurso
para quem não é dono. O mesmo padrão se repete em pedidos (`getOrderOwnedBy`).

## Isolamento de arquivos

Duas camadas independentes de proteção contra path traversal:

1. `control-plane/src/lib/safePath.js` — checagem sintática rápida antes de
   sequer contactar o node (rejeita `..`, caminhos absolutos, bytes nulos).
2. `node-agent/src/lib/safePath.js` — checagem **autoritativa**: resolve o
   caminho contra a raiz real (`fs.realpathSync`) e caminha pelos ancestrais
   existentes para detectar um symlink plantado dentro do volume do cliente
   apontando para fora (ex.: um `ln -s /etc /home/container/escape` feito
   pelo próprio processo do bot). Coberto por teste automatizado.

## Observabilidade

- Logs estruturados em JSON (`lib/logger.js`), com redação automática de
  chaves sensíveis (`token`, `secret`, `password`, ...).
- Auditoria (`audit_log`) para todo evento sensível: login, bloqueio,
  criação/exclusão de servidor, aprovação de pagamento, ações administrativas,
  mudança de estado de node — nunca com segredos no `metadata_json`.
- `/api/admin/overview` agrega contadores (usuários, servidores, nodes,
  receita, profundidade da fila) numa única consulta, em vez do painel bater
  o banco com dezenas de queries por segundo.

## O que ficou fora do escopo desta versão (ver README → "Limitações")

Cota de disco como hard-limit de kernel, provedor de DNS/SSL automático para
domínios, replicação de volume entre nodes para failover automático, e um
caminho HTTP dedicado para upload/download de arquivos grandes.
