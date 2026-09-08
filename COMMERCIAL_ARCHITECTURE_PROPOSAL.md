# COMMERCIAL_ARCHITECTURE_PROPOSAL.md — Sistema Comercial Atlantic Host (Fase 1: Arquitetura)

Status: **PROPOSTA — aguardando aprovação. Nenhum código foi escrito.**

Este documento propõe a arquitetura do novo sistema comercial (Product →
Order → Payment → Proof → Entitlement → Provisioning), substituindo o
fluxo de vendas legado (`plans`/`orders`/`sales.js`/`admin.js`), sem tocar
no SecurityMonitor (Fase 2, já aprovado) e sem contornar
`serviceReadiness.js` (ReadinessGate) nem `SandboxManager`.

> Nota sobre a especificação: não tenho em contexto o texto original da
> "especificação comercial fornecida anteriormente" (provavelmente citada
> numa parte anterior desta conversa que já saiu da janela de contexto).
> Esta proposta foi construída a partir dos requisitos que você reafirmou
> nesta mensagem (bem detalhados) mais a auditoria do sistema legado
> existente. Onde algo depende de uma decisão de negócio que não está
> nesses requisitos, listei explicitamente em "Decisões que precisam de
> aprovação" em vez de presumir.

---

## 0. O que já existe hoje (auditoria do legado)

Antes de propor, mapeei o que já roda em produção:

| Peça | Arquivo | O que faz |
|---|---|---|
| Catálogo | tabela `plans` | Preço, max_bots/ram/cpu, cargo Discord a conceder |
| Carrinho/Pedido | tabela `orders` + `orderManager.js` | Canal privado por pedido, plano + cupom, `original_price`/`total_price` **já são copiados pra order na hora de selecionar o plano** (`updateOrderPlan`) — só o preço é "congelado", não o resto do produto |
| Comprovante | `orders.receipt_url` (1 coluna) | Anexo baixado pro disco (`config.system.receiptsFolder`), **sem criptografia**, sobrescrito se reenviado, apagado do disco só quando o pedido é aprovado/recusado |
| Aprovação | `admin.js` (`admin_approve_*`) | Checa `order.status !== 'in_analysis'` e trava com `updateOrderStatus(orderId,'processing')` **antes de qualquer `await`** — efetivamente um compare-and-swap síncrono, já correto contra clique duplo/dois admins |
| "Ativação" | `planManager.activateUserPlan()` | Só faz `UPDATE users SET plan_id=..., max_bots=...` + adicionar/remover cargo Discord. **Nunca cria nem inicia um bot.** Criar um bot continua sendo uma ação manual e separada do cliente (`add_bot_modal`), sem nenhuma ligação com o pedido aprovado |
| Permissão | `userManager.hasPermission(userId,'admin')` | Hierarquia própria no banco (`viewer<client<moderator<admin`), independente das permissões nativas do Discord (que só controlam quem *vê* o comando `/admin-vendas`) |
| Concorrência entre processos | `instanceLock` (Fase 1) | Já impede DOIS processos Atlantic Host disputando o mesmo banco — a base de "nunca duas instâncias aprovando o mesmo pedido" já existe, uma camada abaixo |

**Achado mais importante para esta proposta:** o sistema legado nunca
provisiona nada de verdade — "ativar plano" é só liberar capacidade
numérica + cargo Discord. O pedido do usuário (`Provisioning →
integração com ReadinessGate/SandboxManager → ACTIVE`) exige uma
capacidade que **não existe hoje** e precisa ser construída: um
`ProvisioningManager` real, que resulta em algo verificável (não só um
número maior no banco).

---

## 1. Arquitetura geral do sistema

```
┌─────────────────────────────────────────────────────────────────────┐
│  DISCORD (única superfície — sem dashboard web, sem site, sem API)   │
│  Canal de carrinho privado (cliente) + canal/painel de revisão       │
│  (staff) — mesmo padrão do sales.js/admin.js atual                   │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │ interações (botão/modal/select)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  CAMADA DE INTERAÇÃO (src/handlers/domains/commerce.js — novo,       │
│  substitui sales.js + parte comercial de admin.js)                    │
│  Só UI: monta embeds, valida permissão de Discord/hasPermission,     │
│  delega tudo de regra de negócio pros managers abaixo. Nunca toca    │
│  no banco diretamente.                                                │
└───────────────────────────────┬───────────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  CAMADA DE DOMÍNIO COMERCIAL (src/managers/commerce/ — novo)          │
│                                                                         │
│  ProductCatalog → OrderManager → PaymentManager → ProofManager        │
│       │                │              │                │              │
│       └────────────────┴──────────────┴────────────────┘              │
│                          │ aprovação humana confirmada                 │
│                          ▼                                             │
│                  ProvisioningManager  ──────────────┐                  │
│                          │                            │ nunca decide   │
│                          ▼                            │ isolamento     │
│                  EntitlementManager                   │ sozinho        │
└──────────────────────────┼─────────────────────────────┼───────────────┘
                            │                             │
                            ▼                             ▼
                ┌───────────────────────┐    ┌─────────────────────────┐
                │ serviceReadiness.js    │    │ processManager.startBot  │
                │ (ReadinessGate)         │    │  → SandboxManager        │
                │ assertProvisioningAllowed()│  │  (ÚNICO ponto de       │
                │ — já existe, Fase 1     │    │   decisão de isolamento) │
                └───────────────────────┘    └─────────────────────────┘

  Infra transversal reutilizada, sem modificação:
  auditManager (audit_log) · fileCrypto (AES-256-GCM) · queueManager
  (fila assíncrona de baixa prioridade) · alertManager (webhook admin +
  DM) · instanceLock (já impede 2 processos) · rateLimiter
```

Princípio central: **o sistema comercial nunca fala diretamente com
sandbox/segurança.** Ele só conversa com dois pontos de entrada
já existentes e não modificados — `assertProvisioningAllowed()` (gate) e
`processManager.startBot()` (que já decide isolamento via
`SandboxManager` internamente) — exatamente como qualquer outro chamador
do sistema hoje. Isso é o que garante, estruturalmente, "não permitir
que o sistema comercial contorne ReadinessGate, SandboxManager ou
Kamikaze": não há nenhum caminho alternativo pra criar/iniciar um bot.

---

## 2. Módulos/classes necessários

Tudo novo vive em `src/managers/commerce/` (pasta nova, só deste
subsistema — mesmo padrão usado pra `src/managers/security/` no Kamikaze).

| Módulo | Responsabilidade | Nunca faz |
|---|---|---|
| `ProductCatalog.js` | CRUD de produtos; monta o **snapshot imutável** de um produto no momento da compra | Aceitar preço vindo do cliente; deixar um pedido antigo "ver" uma edição posterior do produto |
| `OrderManager.js` | Máquina de estados do pedido; único lugar que pode transicionar `orders.status`, via **compare-and-swap** atômico (`UPDATE ... WHERE status = ?`) | Decidir se o pagamento é válido (isso é humano, via `PaymentManager`); provisionar nada |
| `PaymentManager.js` | Registra a expectativa de pagamento (valor, método, dados Pix **snapshotados** no momento do pedido) e a confirmação humana | Marcar `Entitlement`/pedido como `ACTIVE` — só marca o *pagamento* como confirmado |
| `ProofManager.js` | Upload, criptografia em repouso (reusa `fileCrypto.js`), listagem, decrypt sob permissão | Decidir se o comprovante é válido — isso é decisão humana registrada via `PaymentManager` |
| `ProvisioningManager.js` | Orquestrador: `assertProvisioningAllowed()` → estratégia de provisionamento por tipo de produto → chama os pontos de entrada existentes → idempotente, auditável, retryable | Chamar `SandboxManager` diretamente; decidir isolamento; ignorar BLOCKED |
| `EntitlementManager.js` | Concede/revoga a capacidade resultante de um pedido aprovado+provisionado; expiração | Conceder antes do provisionamento confirmar sucesso |
| `CouponManager.js` (adaptado do atual) | Validação e cálculo de desconto, sobre o snapshot do produto | — |
| `CommerceScheduler.js` | Varreduras periódicas: expira carrinhos sem comprovante, expira entitlements vencidos, reconcilia pedidos presos em `PROVISIONING` após um restart | Executar ação alguma sem passar pelos managers acima |

Camada de UI (fina, sem regra de negócio):

- `src/handlers/domains/commerce.js` — substitui `sales.js` e a metade
  comercial de `admin.js`.

Reaproveitados sem modificação: `auditManager.js`, `fileCrypto.js`,
`queueManager.js`, `alertManager.js`, `userManager.js` (`hasPermission`),
`utils/rateLimiter.js`, `serviceReadiness.js`, `processManager.startBot`,
`instanceLock.js`.

---

## 3. Separação entre Product, Order, Payment, Proof e Entitlement

Esta é a mudança estrutural central em relação ao legado (que só tinha
`plans`+`orders`, com "ativação" = efeito colateral direto da aprovação).
Cinco entidades, cada uma com um motivo claro de existir separada:

- **Product** (substitui `plans`): definição do que é vendido — preço,
  limites de recurso, tipo de provisionamento. **Mutável** ao longo do
  tempo (admin pode editar preço/descrição), mas cada `Order` carrega uma
  **cópia congelada** (ver seção 6), nunca uma referência viva.
- **Order**: o EVENTO de compra e seu ciclo de vida. Não sabe "como" o
  pagamento foi feito nem "o que" foi entregue — só orquestra a máquina
  de estados e aponta pra um `Payment`, zero ou mais `Proof`, e (quando
  aprovado) um `Entitlement`.
- **Payment**: o que se ESPERAVA receber (valor, método, dados
  Pix usados) e o veredito humano sobre isso (`pending` → `confirmed` |
  `rejected`). Separado de `Order` porque a v1 usa Pix manual, mas o
  desenho já comporta, no futuro, um gateway automatizado sem redesenhar
  `Order`.
- **Proof**: cada comprovante ENVIADO (pode haver mais de um, se o
  primeiro for recusado por ilegível/errado e o cliente reenviar) —
  histórico completo, nunca sobrescrito, arquivo criptografado em
  repouso.
- **Entitlement**: o que o cliente efetivamente TEM depois de tudo
  confirmado — capacidade/acesso, com seu próprio ciclo de vida
  (`pending_provisioning` → `active` → `expired`/`revoked`). É esta
  entidade, e só ela, que representa "o cliente pode usar o serviço" —
  nunca o `Order` nem o `Payment` sozinhos.

Regra estrutural (implementa diretamente "pagamento confirmado não
significa ACTIVE" e "ACTIVE só depois do provisionamento confirmado"):

```
Payment.status = 'confirmed'   →  NÃO implica Entitlement.status = 'active'
Entitlement.status = 'active'  ⟺  ProvisioningManager confirmou sucesso
```

---

## 4. Modelo de dados e relacionamentos

```
products                          orders
─────────                         ──────────────────────────────
id (PK, texto estável)            id (PK)
name                               user_id          → users(id)
description                        channel_id (único)
price                               product_id        → products(id)  (só referência viva, pra edição futura)
provisioning_type   ┐              product_snapshot  (JSON, imutável — ver §6)
max_bots/ram/cpu     │ definem      coupon_id         → coupons(id)  (nullable)
role_to_grant         │ o produto   original_price
status ('active'/     │             discount_amount
        'archived')   ┘             total_price
                                    status            (máquina de estados — ver §5)
                                    version           (p/ optimistic locking, ver §7)
                                    created_at / updated_at

payments                           proofs
──────────────────────            ──────────────────────────────
id (PK)                           id (PK)
order_id (FK, 1:1)                order_id (FK, 1:N)
method ('pix')                    storage_path        (arquivo cifrado, ver §9)
pix_key_snapshot                  sha256               (integridade)
pix_name_snapshot                 uploaded_by_user_id
pix_city_snapshot                 status ('submitted'/'accepted'/'rejected')
expected_amount                   reviewed_by_admin_id
status ('awaiting_proof'/         review_reason
        'confirmed'/'rejected')   created_at
confirmed_by_admin_id
confirmed_at

entitlements                      provisioning_attempts
──────────────────────            ──────────────────────────────
id (PK)                           id (PK)
order_id (FK, 1:1)                order_id (FK, 1:N)
user_id (FK)                      attempt_number
product_snapshot_ref              status ('running'/'succeeded'/'failed')
status ('pending_provisioning'/   error_message
        'active'/'expired'/       started_at / finished_at
        'revoked')
granted_bot_id (FK bots.id,       coupons  (adaptado do atual — sem mudança estrutural)
  nullable — só se o produto       ──────────────────────────────
  criar um bot automaticamente)   id, code, type, value, max_uses, current_uses,
activated_at / expires_at         expires_at, status  (já existe, reaproveitado)
```

Relacionamentos-chave:

- `orders.product_snapshot` é a fonte de verdade pra tudo que a UI
  mostra depois da confirmação — nunca um novo `JOIN` em `products` pra
  decidir preço/limites de um pedido já existente.
- `payments` é 1:1 com `orders` na v1 (Pix manual, uma tentativa de
  pagamento por pedido — reenviar comprovante é um novo `Proof`, não um
  novo `Payment`). Fica pronto pra virar 1:N se um dia existir "pagamento
  parcial"/reprocessamento de gateway, mas isso não é escopo da v1.
- `proofs` é 1:N — histórico completo de tentativas de comprovante.
- `entitlements` é 1:1 com `orders` (um pedido aprovado gera exatamente
  um entitlement) mas N:1 com `users` (um usuário acumula vários
  entitlements ao longo do tempo — inclusive de produtos diferentes).
- `provisioning_attempts` é 1:N com `orders` — histórico de tentativas,
  base da idempotência (§8) e da auditoria.

---

## 5. Máquina de estados dos pedidos e transições válidas

```
                    ┌──────────────────────────────────────────┐
                    │                                            │
   DRAFT ──────► AWAITING_PAYMENT ──► PROOF_SUBMITTED ──► UNDER_REVIEW
     │                  │                                        │  │
     │ cancelar          │ timeout sem                            │  │ aprova
     ▼                   │ comprovante                            │  ▼
 CANCELLED                ▼                                       │ APPROVED
                      EXPIRED                        recusa ◄──────┘  │
                                                         │            │ ProvisioningManager
                                                         ▼            ▼
                                                     REJECTED     PROVISIONING
                                                                       │  │
                                                            sucesso ◄──┘  └──► falha
                                                                │              │
                                                                ▼              ▼
                                                             ACTIVE   PROVISIONING_FAILED
                                                                              │
                                                                    retry (admin) ──► PROVISIONING
```

Tabela de transições válidas (qualquer transição fora desta tabela é
rejeitada pelo `OrderManager` — nunca um `UPDATE` livre):

| De | Para | Gatilho |
|---|---|---|
| `DRAFT` | `AWAITING_PAYMENT` | Cliente confirma produto (snapshot criado, valor calculado) |
| `DRAFT` | `CANCELLED` | Cliente cancela antes de confirmar |
| `AWAITING_PAYMENT` | `PROOF_SUBMITTED` | Cliente envia comprovante |
| `AWAITING_PAYMENT` | `CANCELLED` | Cliente cancela |
| `AWAITING_PAYMENT` | `EXPIRED` | Varredura periódica, sem comprovante dentro do prazo |
| `PROOF_SUBMITTED` | `UNDER_REVIEW` | Admin abre o pedido pra analisar |
| `UNDER_REVIEW` | `PROOF_SUBMITTED` | Admin pede reenvio (comprovante ilegível), sem recusar formalmente |
| `UNDER_REVIEW` | `APPROVED` | Admin confirma o pagamento (`Payment.status='confirmed'`) |
| `UNDER_REVIEW` | `REJECTED` | Admin recusa (motivo obrigatório) |
| `APPROVED` | `PROVISIONING` | `ProvisioningManager` inicia (automático, assíncrono) |
| `PROVISIONING` | `ACTIVE` | Provisionamento confirmado com sucesso |
| `PROVISIONING` | `PROVISIONING_FAILED` | Falha (inclusive `BLOCKED` do ReadinessGate) |
| `PROVISIONING_FAILED` | `PROVISIONING` | Admin aciona nova tentativa (idempotente — §8) |

Terminais: `CANCELLED`, `EXPIRED`, `REJECTED`, `ACTIVE`. Nenhuma transição
pula etapa (nunca `DRAFT → ACTIVE`, nunca `AWAITING_PAYMENT → APPROVED`).

---

## 6. Snapshot imutável do produto no momento da compra

Ao confirmar o produto (transição `DRAFT → AWAITING_PAYMENT`),
`OrderManager` grava em `orders.product_snapshot` um JSON com **todos**
os campos comercialmente relevantes do produto no instante exato —
não só o preço (que já é congelado hoje), mas também nome, descrição,
limites de recurso, tipo de provisionamento, cargo Discord a conceder,
versão do produto. A partir daí, **nada** que a UI mostra ou que o
`ProvisioningManager` usa para decidir limites de recurso volta a ler
`products` — sempre lê o snapshot do próprio pedido.

Isto implementa diretamente a regra "pedidos históricos não podem ser
alterados por mudanças posteriores no produto" — hoje isso já é
parcialmente verdade pro preço; a proposta generaliza pra TODO o produto.

`products.id` nunca é reaproveitado pra outro produto (mesma disciplina
já usada pra `plans.id` hoje) — mas mesmo que fosse, o snapshot
protegeria os pedidos antigos de qualquer jeito.

---

## 7. Controle de concorrência e prevenção de aprovação dupla

O legado já resolve a classe de bug mais perigosa (aprovar o mesmo
pedido duas vezes) do jeito certo: checa o status e trava com uma
`UPDATE` síncrona **antes de qualquer `await`** — como Node é
single-threaded e o driver SQLite usado (`node:sqlite`) é síncrono, não
existe uma janela real de corrida entre o check e o lock dentro do mesmo
pedaço de código síncrono.

Proposta: formalizar isso como o único primitivo de transição do
`OrderManager`, em vez de cada handler reimplementar o padrão à mão:

```js
// Pseudocódigo da assinatura, não implementação:
transitionOrder(orderId, fromStatuses /* array */, toStatus, extra = {})
  → executa UM UPDATE atômico: "UPDATE orders SET status=? ... WHERE id=? AND status IN (...)"
  → lê `changes` do resultado: 0 mudanças = a transição não aconteceu
    (outro admin/processo já mudou o status antes) → retorna falha,
    NUNCA lança uma exceção genérica que possa ser mal interpretada
  → só em caso de sucesso real (changes=1) o chamador prossegue
```

Isso cobre tanto "dois admins clicando Aprovar quase ao mesmo tempo"
quanto "o mesmo admin clicando duas vezes" — ambos batem no `WHERE
status IN (...)` e só um vence.

Concorrência ENTRE PROCESSOS (dois Atlantic Host rodando por engano) já
é coberta por `instanceLock.js` (Fase 1) — o sistema comercial não
precisa reinventar nada aqui, herda a garantia de instância única.

---

## 8. Idempotência do provisionamento

`ProvisioningManager.provision(orderId)` precisa ser seguro de chamar
mais de uma vez pro mesmo pedido (retry manual do admin, ou reconciliação
pós-restart). Camadas:

1. **Transição de estado como trava**: só entra em execução de verdade
   se conseguir transicionar `APPROVED → PROVISIONING` (ou
   `PROVISIONING_FAILED → PROVISIONING`) via o primitivo do §7. Uma
   segunda chamada concorrente simplesmente falha a transição e sai sem
   fazer nada.
2. **Checagem de resultado já existente**: antes de executar qualquer
   passo, relê o `Entitlement` do pedido — se já estiver `active`,
   retorna sucesso imediatamente (no-op), nunca reprocessa.
3. **Cada passo de provisionamento é ele mesmo idempotente** (ex.: "já
   existe uma linha de bot associada a este pedido? usa a existente, não
   cria duplicata").
4. **Registro por tentativa** (`provisioning_attempts`): cada chamada
   grava uma linha própria — histórico completo, nunca sobrescrito,
   igual ao princípio do `audit_log`.
5. **Reconciliação pós-restart**: mesmo padrão já usado por
   `IncidentResponseManager.reconcileStuckIncidents()` — no boot, uma
   varredura marca pedidos presos em `PROVISIONING` (o processo caiu no
   meio) como `PROVISIONING_FAILED`, nunca tenta resumir um
   provisionamento parcial às cegas. Fica pronto pra retry manual do
   admin depois.

---

## 9. Armazenamento seguro dos comprovantes

Hoje: arquivo em texto puro no disco, indefinidamente até a aprovação
(ou pra sempre, se o pedido nunca for processado).

Proposta:

- Todo `Proof` é criptografado em repouso com `fileCrypto.encryptBuffer()`
  (AES-256-GCM, já existe, já usada pra backups) — reaproveita a MESMA
  `ENCRYPTION_KEY` já validada no boot, sem nova infraestrutura de
  chave.
- Nomeado pelo `proof.id` (opaco), não pelo `order.id` — reduz
  correlação trivial ao navegar a pasta.
- `sha256` do conteúdo original gravado na linha do `Proof`
  (`fileCrypto.sha256`) — verificação de integridade independente da
  camada de criptografia.
- Decrypt só através de `ProofManager.getDecryptedProof(proofId,
  requestingUserId)`, que checa permissão **dentro do próprio manager**
  (defesa em profundidade — nunca confia só na camada de UI ter checado
  antes), no mesmo espírito de `canManageBot()`.
- Retenção: purga automática depois de um prazo configurável após o
  pedido chegar a um estado terminal (ver "Decisões pendentes" — prazo
  exato depende de exigência legal/fiscal que não devo presumir).
- Limitação inerente à restrição "100% dentro do Discord": pra um
  admin revisar visualmente, o comprovante PRECISA aparecer como anexo
  numa mensagem do Discord — nesse momento ele passa a existir também
  nos servidores do Discord, fora do nosso controle. Mitigação: canal de
  revisão restrito ao papel administrativo, e apagar a mensagem de
  revisão (não o registro em si) depois da decisão — risco residual
  documentado na seção 20, não eliminável na v1 dada a restrição de
  "sem dashboard/site" (ver decisão pendente #8).

---

## 10. Sistema de auditoria

Reaproveita `auditManager.recordAuditEvent`/`audit_log` — a mesma tabela
append-only, nunca podada, já usada pelo Kamikaze — com uma convenção de
nome de evento prefixada `commerce:` (paralela a `security_signal:` e
`kamikaze:`), sem nenhuma tabela nova só pra isso:

Eventos mínimos a auditar (todos com `userId` de quem agiu, quando
aplicável):

- `commerce:order_created`, `commerce:product_confirmed` (com snapshot)
- `commerce:proof_submitted`
- `commerce:order_under_review` (por qual admin)
- `commerce:payment_confirmed` / `commerce:payment_rejected` (admin +
  motivo)
- `commerce:provisioning_started` / `_succeeded` / `_failed` (com o
  motivo, inclusive se foi `BLOCKED` do ReadinessGate)
- `commerce:entitlement_granted` / `_expired` / `_revoked`
- `commerce:order_cancelled` / `_expired`
- `commerce:coupon_applied` / `_over_limit` (mesmo alerta que o legado
  já tem hoje, preservado)
- `commerce:admin_role_changed` (se a decisão pendente #5 criar um papel
  novo)

Isto satisfaz "toda transição financeira/administrativa importante deve
ser auditável" sem inventar um sistema de log paralelo.

---

## 11. Expiração e cancelamento

Dois ciclos de vida distintos, que não devem ser confundidos:

- **Expiração do PEDIDO** (carrinho): `AWAITING_PAYMENT` sem
  `PROOF_SUBMITTED` dentro de uma janela configurável (proposta:
  default 48h, ajustável) → `EXPIRED` via `CommerceScheduler`. Nunca
  cobra, nunca provisiona nada.
- **Expiração do ENTITLEMENT**: só relevante se a decisão pendente #3
  (assinatura recorrente) for confirmada — um `Entitlement` com
  `expires_at` vencido é sinalizado por uma varredura própria, revoga
  capacidade (reduz `max_bots`/remove cargo), e — importante —
  **nunca** aciona `IncidentResponseManager`/Kamikaze. É um evento de
  ciclo de vida comercial de rotina, não um incidente de segurança;
  continua usando `bots.suspended` como já existe hoje se precisar
  suspender um bot por falta de pagamento, exatamente como uma
  suspensão manual de moderador já faz.
- **Cancelamento pelo cliente**: permitido em `DRAFT`,
  `AWAITING_PAYMENT`, `PROOF_SUBMITTED` (ainda não em revisão ativa).
  Uma vez `UNDER_REVIEW`, o cliente não cancela mais sozinho — só o
  admin, via recusa formal (garante que toda decisão sobre um pedido em
  análise fica auditada como aprovação/recusa, nunca "sumiu").

---

## 12. Integração com ReadinessGate

`ProvisioningManager.provision()` chama
`assertProvisioningAllowed('provisionamento comercial: pedido #<id>')`
— a MESMA função já usada por `startBot()`/`installDependencies()` —
como primeiro passo, antes de qualquer efeito colateral. Se o serviço
estiver `BLOCKED`, a chamada lança, a transição vai para
`PROVISIONING_FAILED` (nunca `ACTIVE`), o admin é notificado
(`alertManager`), e o pagamento **permanece confirmado** — nada é
estornado automaticamente (decisão de reembolso é humana, ver §20/#4).
Isto é a implementação literal de "ACTIVE só pode ocorrer após
provisionamento confirmado" e "não contornar o ReadinessGate": não existe
nenhum caminho de código que chegue em `ACTIVE` sem passar por essa
checagem.

`DEGRADED` nunca bloqueia — mesma semântica já estabelecida na Fase 1
(hospedagem continua operando normalmente; só reduz observabilidade
auxiliar).

---

## 13. Integração com SandboxManager

`ProvisioningManager` **nunca importa `SandboxManager` nem
`processManager` diretamente pra tomar decisão de isolamento** — ele
delega ao ponto de entrada que já existe hoje pra qualquer criação de
bot (`processManager.startBot()`, que já chama
`SandboxManager.decideBackend()` internamente, fail-closed, sem fallback
silencioso — arquitetura pré-existente de `SECURITY_ARCHITECTURE.md`,
inalterada). Isso preserva a invariante já documentada: SandboxManager é
o único lugar que decide isolamento, ninguém mais.

Na prática, isso só se aplica aos tipos de produto cuja estratégia de
provisionamento efetivamente cria/inicia um processo de bot — ver §14 e
decisão pendente #1.

---

## 14. Arquitetura do ProvisioningManager

Desenhado como uma **estratégia por tipo de produto**
(`product.provisioning_type`), porque a pergunta "o que exatamente é
entregue numa compra" é uma decisão de negócio ainda aberta (decisão
pendente #1/#2) — a arquitetura não deveria travar nisso.

```
provision(orderId):
  1. relê Order + Entitlement atuais — se já 'active', retorna sucesso (idempotente, §8)
  2. transitionOrder(orderId, ['APPROVED','PROVISIONING_FAILED'], 'PROVISIONING')
     — se falhar (outro processo já pegou), retorna sem fazer nada
  3. assertProvisioningAllowed(...) — ReadinessGate, fail-closed
  4. strategy = strategies[order.product_snapshot.provisioning_type]
  5. try:
       result = await strategy.execute(order)     // única parte que varia por tipo de produto
       EntitlementManager.grant(orderId, result)
       transitionOrder(orderId, ['PROVISIONING'], 'ACTIVE')
       recordAuditEvent('commerce:provisioning_succeeded', ...)
     catch (err):
       transitionOrder(orderId, ['PROVISIONING'], 'PROVISIONING_FAILED')
       recordAuditEvent('commerce:provisioning_failed', ...)
       alertManager.sendAlert(...)   // nunca falha silenciosamente
```

Estratégias possíveis (a decidir — pendente #1), todas atrás da MESMA
interface `execute(order) → result`, todas passando por
`processManager.startBot()`/ReadinessGate quando envolverem um bot de
verdade:

- `entitlement_only`: só concede capacidade (`max_bots`/`max_ram` no
  usuário) — sem criar bot algum, igual ao comportamento atual, cliente
  cria o bot depois manualmente.
- `bot_slot_reserved`: cria a linha do bot com status "aguardando
  token", mas não inicia nada (não dá pra iniciar um bot Discord sem o
  token do cliente).
- Um tipo adicional só faria sentido pra produtos que a plataforma
  consegue provisionar sem input do cliente (ex.: web/app hosting com
  código padrão) — fora do escopo confirmado, não proposto aqui sem
  decisão explícita.

Enfileiramento: assim como `SecurityMonitor.js` nunca chama Groq inline,
`ProvisioningManager` roda a chamada de `provision()` via
`queueManager.js` (prioridade normal/alta, nunca inline na interação do
Discord) — a aprovação do admin responde na hora ("aprovado, processando
provisionamento..."), o resultado chega depois via mensagem/DM, sem
travar a interação nem o processo principal.

---

## 15. Isolamento entre sistema comercial e execução dos bots

- **Módulo**: `src/managers/commerce/` nunca importa nada de
  `src/managers/security/` além de, no máximo, ler `serviceReadiness.js`
  (já público, já pensado pra ser consultado por qualquer parte do
  sistema). Nunca importa `SecurityEngine.js`,
  `IncidentResponseManager.js`, nem `SecurityMonitor.js` — instrução
  explícita, e também não haveria motivo (Kamikaze não precisa saber
  nada sobre vendas).
- **Dados**: tabelas comerciais (`products`, `orders`, `payments`,
  `proofs`, `entitlements`, `provisioning_attempts`) nunca são escritas
  fora de `src/managers/commerce/`. Escrita em `bots.*` continua
  passando exclusivamente pelas funções já existentes e auditadas
  (`processManager.startBot`, criação de bot via `bots.js`) — o
  comercial nunca faz `UPDATE bots SET token=...` diretamente.
- **Falhas**: qualquer exceção dentro de `ProvisioningManager`/
  `CommerceScheduler` é capturada e vira `PROVISIONING_FAILED` +
  auditoria — nunca derruba o processo principal (mesmo padrão de
  `reportSignal`/`reconcileStuckIncidents`: erro em background nunca é
  deixado propagar sem tratamento).
- **Kamikaze permanece cego ao comercial**: se um bot comprado
  posteriormente disparar um sinal CRITICAL, o Kamikaze age exatamente
  como agiria com qualquer outro bot — sem nenhum código especial pra
  "bots comprados". O inverso também: o comercial não precisa (e não
  deve) saber se um bot está em quarentena pra funcionar — se algum dia
  precisar refletir isso ao cliente, lê `bots.suspended` do mesmo jeito
  que qualquer parte read-only do sistema já faz.

---

## 16. Permissões administrativas dentro do Discord

Duas camadas, preservando o modelo dual já existente:

1. **Nativa do Discord**: quem consegue ver/usar o comando e o canal de
   revisão — via permissão de canal (`admin_role_id` já existe em
   `sales_config`, mantido) e, se aplicável, `default_member_permissions`
   do slash command.
2. **Interna da aplicação**: `hasPermission(userId, 'admin')` checado
   **dentro de cada handler** (nunca só confiar na camada 1 — mesmo
   padrão defensivo já usado em `admin.js` hoje, preservado).

Proposta adicional (pendente de decisão #5): introduzir um papel mais
granular — `hasCommercePermission(userId, action)`, no mesmo espírito de
`canManageBot()` — pra permitir, no futuro, que "quem aprova pagamento"
seja um conjunto de pessoas diferente de "quem administra bots/segurança
da plataforma", sem forçar todo mundo a virar `admin` completo. Default
proposto até decisão em contrário: continuar exigindo `admin` (nível
mais alto da hierarquia atual), igual ao legado, e não introduzir um
papel novo na v1 a menos que seja pedido explicitamente.

---

## 17. Fluxo completo: cliente → pedido → Pix → comprovante → aprovação → provisionamento → ACTIVE

```
1.  Cliente abre carrinho (canal privado, mesmo padrão do sales.js) — Order:DRAFT
2.  Cliente escolhe o produto — OrderManager grava product_snapshot,
    calcula total (com cupom opcional) — Order:AWAITING_PAYMENT
3.  Tela de pagamento mostra os dados Pix SNAPSHOTADOS no Payment (não
    lidos ao vivo de sales_config) — nunca aceita valor digitado pelo cliente
4.  Cliente envia comprovante — ProofManager cifra e salva — Proof criado,
    Order:PROOF_SUBMITTED
5.  Admin abre o pedido pra revisão — Order:UNDER_REVIEW (trava contra
    dois admins abrindo o mesmo pedido pra decidir ao mesmo tempo — o
    próprio §7 se aplica aqui também)
6a. Admin aprova → PaymentManager.confirm() → Order:APPROVED →
    ProvisioningManager.provision() enfileirado → Order:PROVISIONING
6b. Admin recusa (motivo obrigatório) → Order:REJECTED, cliente notificado
7.  ProvisioningManager: ReadinessGate → estratégia do produto →
    sucesso: EntitlementManager.grant() → Order:ACTIVE, cliente notificado
    falha: Order:PROVISIONING_FAILED, admin alertado, pagamento
    permanece confirmado (nada é revertido automaticamente)
8.  Canal do carrinho fechado (mesmo padrão do legado — mensagem +
    delete com atraso)
```

---

## 18. Tratamento de falhas em cada etapa

| Etapa | Falha possível | Tratamento |
|---|---|---|
| Criar carrinho | Canal Discord falha a meio caminho | Mesmo padrão já existente (rollback do canal órfão) — preservado |
| Confirmar produto | Produto foi arquivado entre a exibição e a confirmação | `OrderManager` relê `products.status` antes de gravar o snapshot — recusa se não estiver `active` |
| Aplicar cupom | Cupom expira/estoura limite entre aplicar e aprovar | Já corrigido no legado (revalida no momento da confirmação, avisa admin) — preservado e generalizado |
| Enviar comprovante | Upload falha, formato inválido | `ProofManager` valida antes de gravar; falha não muda o status do pedido, cliente pode tentar de novo |
| Dois admins abrem o mesmo pedido | Corrida em `UNDER_REVIEW` | CAS do §7 — só um consegue |
| Aprovar | Dois cliques / dois admins | CAS do §7 — idêntico ao já corrigido no legado |
| Provisionamento | `ReadinessGate` BLOCKED | `PROVISIONING_FAILED` imediato, fail-closed, sem fallback |
| Provisionamento | Exceção inesperada em qualquer passo | Capturada, `PROVISIONING_FAILED`, auditado, admin alertado |
| Provisionamento | Processo cai no meio | Reconciliação no boot (mesmo padrão do Kamikaze) → `PROVISIONING_FAILED`, nunca resume às cegas |
| Provisionamento | Falha permanente (sem capacidade no host) | Fica `PROVISIONING_FAILED` até decisão humana — reembolso/retry/outro produto é decisão de negócio (pendente #11) |
| Notificar cliente (DM) | DM fechada | Mesmo padrão já usado em todo o sistema — `.catch(() => {})`, nunca bloqueia o fluxo |

---

## 19. O que pode ser reutilizado do legado e o que deve ser substituído

**Reutilizado, sem modificação:**
- `auditManager.js` (audit_log)
- `fileCrypto.js` (criptografia de comprovantes)
- `queueManager.js` (provisionamento assíncrono)
- `alertManager.js` (notificações admin/cliente)
- `userManager.js` (`hasPermission`, hierarquia de papéis)
- `utils/rateLimiter.js` (limite de carrinhos, tentativas de cupom)
- `instanceLock.js`, `serviceReadiness.js` (Fase 1, inalterados)
- `processManager.startBot()` → `SandboxManager` (Fase 0, inalterado)
- Padrão de canal privado por pedido + permissões (`sales_buy_plan`)
- Padrão de CAS síncrono contra duplo-processamento (`admin_approve_`)
- `coupons` (tabela e regras, adaptadas ao novo modelo de snapshot)

**Substituído/redesenhado:**
- `plans`/`orders` (schema) → `products`/`orders`/`payments`/`proofs`/
  `entitlements`/`provisioning_attempts`
- `orderManager.js`/`planManager.js` → `OrderManager.js` (máquina de
  estados explícita) + `EntitlementManager.js`
- `activateUserPlan()` (bump de números + cargo) →
  `ProvisioningManager.js` + `EntitlementManager.js` (resultado real e
  verificável, gated por ReadinessGate)
- Armazenamento de comprovante em texto puro → `ProofManager.js`
  (cifrado, histórico completo)
- `sales.js` + metade comercial de `admin.js` → `commerce.js` (fino,
  delega tudo pros managers)

**Avaliar caso a caso, sem redesenho estrutural necessário:**
- `affiliateManager.js` — provavelmente compatível assim que
  `Order`/`Payment` estiverem separados; revisar depois da aprovação
  desta arquitetura, não bloqueia a proposta.

---

## 20. Riscos de segurança e riscos financeiros

**Segurança:**
- IDOR/escalonamento nas interações do Discord (customId manipulado) —
  mitigado exigindo `hasPermission`/checagem de dono em CADA handler
  novo, com testes dedicados (mesmo padrão desta sessão).
- Corrupção/adulteração de comprovante em repouso — mitigado por
  AES-256-GCM (autenticado) + hash SHA-256 independente.
- Vazamento de comprovante ao ser exibido no Discord pra revisão — risco
  residual **inerente** à restrição "100% dentro do Discord" (seção 9) —
  mitigação parcial (canal restrito, mensagem apagada após decisão), não
  eliminável na v1.
- Compromisso da conta de um admin = poder de "aprovar" pedidos
  fraudulentos — mitigado por auditoria completa (quem aprovou o quê,
  quando) e, se aprovado (decisão pendente #6), aprovação dupla acima de
  um valor configurável.
- Contorno do ReadinessGate/SandboxManager — estruturalmente impossível
  no desenho proposto (§12/§13) — sem caminho de código alternativo.

**Financeiro:**
- Comprovante falsificado (Pix "photoshopado") — v1 depende de revisão
  humana (sem validação automática de extrato bancário) — risco aceito
  e explícito, não escondido; mitigação é procedimento (treinamento do
  time de revisão), não técnica, nesta fase.
- Preço manipulado pelo cliente — estruturalmente impossível (preço
  sempre derivado do produto pelo ID interno, nunca aceito como input
  livre — já é assim no legado via menu de seleção, mantido).
  vazamento de limite de cupom — já corrigido no legado, preservado e
  generalizado pro novo modelo.
- Abuso de carrinho (spam de canais) — já mitigado por rate limit,
  preservado.
- Estorno/reembolso — fora do escopo explícito dos requisitos — sinaliza
  como decisão pendente #4 em vez de presumir uma política.
- Reconciliação financeira: nenhum relatório/dashboard foi pedido (e
  "sem dashboard web" é regra obrigatória) — relatórios ficam limitados
  ao que der pra mostrar dentro do Discord (ex.: comando de resumo,
  como o `admin_stats` já existente) — suficiência disso pra fins
  contábeis/fiscais é uma decisão de negócio, não técnica.

---

## Decisões que precisam de aprovação

1. **O que exatamente "provisionamento" entrega por tipo de produto?**
   Proponho um desenho plugável (`provisioning_type`) justamente porque
   não tenho essa resposta — precisa vir de você: só liberar
   capacidade/cargo (como hoje), reservar um "slot" de bot aguardando
   token do cliente, ou outra coisa.
2. **Os produtos vendem "capacidade" (N bots/RAM, como hoje) ou
   "serviços específicos" (ex.: "1 bot hospedado")? Os dois tipos vão
   coexistir na v1?**
3. **Existe assinatura recorrente (expiração/renovação) na v1, ou só
   compra avulsa sem expiração por enquanto?** Afeta diretamente se
   `EntitlementManager`/`CommerceScheduler` precisam de lógica de
   expiração já na primeira versão.
4. **Reembolso/estorno faz parte do escopo da v1?** Se sim, precisa de
   um estado `REFUNDED` e de uma decisão sobre reversão de
   entitlement/bot já provisionado.
5. **Precisa de um papel Discord específico para aprovação financeira
   (distinto de `admin` geral), ou `admin` já cobre isso na v1?**
6. **Aprovações de valor alto exigem um segundo aprovador (four-eyes),
   ou aprovação por um único admin é aceitável na v1?**
7. **Prazo de expiração do carrinho sem comprovante** — proponho 48h
   como default ajustável, mas o valor é uma decisão de negócio.
8. **Prazo de retenção do comprovante após o pedido fechar** — pode
   ter implicação legal/fiscal brasileira (Pix, nota fiscal, etc.) que
   não devo presumir.
9. **O sistema comercial atende só um servidor Discord (como hoje,
   `sales_config` é uma única linha global) ou precisa suportar
   múltiplos servidores/storefronts já na v1?**
10. **Cupons e comissão de afiliados continuam com as mesmas regras de
    negócio de hoje, ou há mudanças a incorporar junto deste
    redesenho?**
11. **O que acontece com um pedido aprovado cujo provisionamento falha
    permanentemente** (ex.: sem capacidade no host)? Fila de espera,
    reembolso manual, oferecer produto alternativo — decisão de
    negócio, não técnica.
12. **Confirmação de idioma/tom dos textos ao cliente/admin** — mantenho
    o padrão em português já usado no sistema, salvo instrução em
    contrário.

---

**Parando aqui, conforme instruído.** Nenhum arquivo de implementação foi
criado ou modificado nesta etapa — só este documento de proposta.
