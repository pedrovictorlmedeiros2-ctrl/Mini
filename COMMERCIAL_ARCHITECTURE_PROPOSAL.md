# COMMERCIAL_ARCHITECTURE_PROPOSAL.md — Sistema Comercial Atlantic Host

Status: **APROVADO (arquitetura) — aguardando aprovação para iniciar a
implementação (Fase 2).** Nenhum código de implementação foi escrito.

Este documento incorpora as 17 decisões de negócio confirmadas sobre a
proposta original. Substitui integralmente a versão anterior (que
listava "decisões pendentes" — todas agora resolvidas e refletidas
abaixo). Continua sem tocar no SecurityMonitor (Fase 2 do Kamikaze, já
aprovado) e sem contornar `serviceReadiness.js` (ReadinessGate),
`SandboxManager` ou o restante da arquitetura de segurança existente.

## Decisões incorporadas nesta versão

1. V1 vende **planos de capacidade de hospedagem** — o provisionamento
   **nunca cria bot automaticamente**.
2. `Entitlement` = a capacidade efetivamente adquirida pelo cliente.
3. Planos são **mensais** na v1 (campo de período já existe no schema,
   pronto pra outros períodos no futuro, sem uso na v1).
4. Renovação cria um **novo Order/Payment**, preservando o histórico
   anterior — nunca reescreve um pedido já existente.
5. Pagamento aprovado **não** implica `Entitlement.ACTIVE` — só o
   provisionamento confirmado ativa.
6. Reembolso/estorno **sem automação na v1** — arquitetura deixa a
   extensão futura aditiva (sem redesenho).
7. Nova permissão comercial **`COMMERCE_STAFF`**, independente de
   `Administrator`.
8. **Sem** segundo aprovador (four-eyes) na v1 — extensão futura aditiva.
9. Pedidos sem comprovante expiram em **2h por padrão, configurável**.
10. V1 é **um único servidor Discord**; `guild_id` presente só onde não
    complica a implementação.
11. Cupons **desacoplados** de `Payment` e `Provisioning`.
12. Afiliados/comissões **fora de escopo** na v1.
13. Comprovantes com armazenamento protegido, hash e histórico; retenção
    **configurável**, sem presumir obrigação legal não definida.
14. Falha permanente de provisionamento: pagamento **permanece
    confirmado**, cliente **não paga de novo**, pedido **permanece
    rastreável** para retry/reconciliação da equipe.
15. `ProvisioningManager` valida idempotência **antes** de
    `assertProvisioningAllowed()`; depois disso, respeita
    obrigatoriamente ReadinessGate/SandboxManager/segurança existente.
16. Sistema comercial **nunca** cria processos/spawn diretamente.
17. Idioma da interface: **português-BR**.

---

## 1. Arquitetura final

```
┌─────────────────────────────────────────────────────────────────────┐
│  DISCORD (única superfície — sem dashboard web, sem site, sem API)   │
│  Canal de carrinho privado (cliente) + fila/canal de revisão          │
│  (COMMERCE_STAFF/admin) — pt-BR                                       │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │ interações (botão/modal/select)
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  src/handlers/domains/commerce.js  (UI fina, sem regra de negócio)    │
│  Valida permissão de Discord + hasCommercePermission(); delega tudo   │
│  de regra de negócio pros managers abaixo.                            │
└───────────────────────────────┬───────────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────────┐
│  src/managers/commerce/  (domínio comercial, novo)                    │
│                                                                         │
│  ProductCatalog → OrderManager → PaymentManager → ProofManager        │
│       │                │              │                │              │
│       └────────────────┴──────────────┴────────────────┘              │
│                          │ aprovação humana (COMMERCE_STAFF/admin)     │
│                          ▼                                             │
│                  ProvisioningManager  ─────────────────┐               │
│                          │ v1: só concede capacidade     │ nunca cria  │
│                          │     (entitlement_only)         │ processo/  │
│                          ▼                                │ spawn      │
│                  EntitlementManager                       │            │
│                          │                                 │            │
│                  CommerceScheduler (expiração de carrinho   │            │
│                  e de entitlement mensal)                    │            │
└──────────────────────────┼──────────────────────────────────┼───────────┘
                            │                                  │
                            ▼                                  ▼
                ┌───────────────────────┐         ┌─────────────────────────┐
                │ serviceReadiness.js     │         │ (v1: nenhum — nenhuma    │
                │ (ReadinessGate)          │         │  estratégia da v1 toca   │
                │ assertProvisioningAllowed()│       │  em processo/sandbox)    │
                │ — existente, inalterado  │         │  Ponto reservado pra     │
                └───────────────────────┘         │  processManager.startBot()│
                                                     │  quando/se um dia uma     │
                                                     │  estratégia precisar —    │
                                                     │  nunca spawn direto        │
                                                     └─────────────────────────┘

  Infra transversal reutilizada, sem modificação:
  auditManager (audit_log) · fileCrypto (AES-256-GCM) · queueManager ·
  alertManager · instanceLock · rateLimiter · userManager.hasPermission
```

Como a v1 só concede capacidade (decisão #1), `ProvisioningManager`
**ainda assim** passa obrigatoriamente por `assertProvisioningAllowed()`
antes de conceder qualquer coisa — não porque a v1 precise de isolamento
de sandbox, mas porque essa é a regra arquitetural permanente (nenhum
provisionamento comercial, hoje ou no futuro, pula esse gate). Quando uma
estratégia futura precisar de fato criar/iniciar um bot, o único caminho
permitido continua sendo `processManager.startBot()` — nunca um novo
ponto de entrada.

---

## 2. Modelo de dados final

```
products                              orders
─────────────────────────            ──────────────────────────────────
id (PK, texto estável)                id (PK)
guild_id (nullable)                    guild_id
name                                    user_id           → users(id)
description                             channel_id (único)
price                                    product_id        → products(id) (viva, só p/ catálogo)
max_bots / max_ram / max_cpu / storage  product_snapshot  (JSON imutável — §6 da v. anterior, mantido)
billing_period ('monthly', fixo v1)     coupon_id         → coupons(id), nullable
role_to_grant / role_to_remove          renewal_of_entitlement_id → entitlements(id), nullable
status ('active'/'archived')            original_price / discount_amount / total_price
created_at / updated_at                 status            (máquina de estados — §3)
                                         created_at / updated_at

payments                              proofs
─────────────────────────            ──────────────────────────────────
id (PK)                               id (PK)
order_id (FK, 1:1)                    order_id (FK, 1:N)
method ('pix')                         storage_path       (cifrado — §13)
pix_key_snapshot                        sha256
pix_name_snapshot                       uploaded_by_user_id
pix_city_snapshot                       status ('submitted'/'accepted'/'rejected')
expected_amount                         reviewed_by_admin_id
status ('awaiting_proof'/               review_reason
        'confirmed'/'rejected')         created_at
confirmed_by_admin_id  → users(id)
  (precisa hasCommercePermission)
confirmed_at
created_at

entitlements                          provisioning_attempts
─────────────────────────            ──────────────────────────────────
id (PK)                               id (PK)
guild_id                               order_id (FK, 1:N)
order_id (FK, 1:1)                     attempt_number
user_id → users(id)                    status ('running'/'succeeded'/'failed')
status ('pending_provisioning'/        error_message
        'active'/'expired'/'revoked')  started_at / finished_at
activated_at
expires_at   (activated_at + 1 mês —   commerce_staff  (NOVO — decisão #7)
  billing_period do snapshot)          ──────────────────────────────────
created_at                             user_id (PK, FK users.id)
  Limites (max_bots/ram/cpu) são        guild_id (nullable)
  SEMPRE lidos via order_id →           granted_by → users(id)
  product_snapshot — nunca              granted_at
  duplicados aqui (uma única           revoked_by / revoked_at (nullable —
  fonte de verdade).                     soft-revoke, mantém histórico)

coupons  (existente, sem mudança estrutural — id, code, type, value,
  max_uses, current_uses, expires_at, status). NUNCA referenciado por
  `payments` nem `provisioning_attempts` — só por `orders.coupon_id`
  (decisão #11, ver §7).
```

Notas de simplificação em relação ao rascunho anterior:

- **Removida** a coluna `version` de `orders` (optimistic locking) — o
  primitivo de transição por `status` (§4) já garante concorrência
  segura sozinho; uma segunda trava seria redundante.
- **Removido** `entitlements.product_snapshot_ref` — o entitlement lê os
  limites sempre via `order_id → orders.product_snapshot`, nunca duplica
  o valor (evita duas fontes de verdade divergentes).
- **Removida** a coluna `orders.order_type` — é totalmente derivável de
  `renewal_of_entitlement_id IS NOT NULL`, então não precisa existir
  como campo separado.
- `guild_id` foi colocado só em `products`, `orders`, `entitlements` e
  `commerce_staff` — nunca em `payments`/`proofs`/
  `provisioning_attempts`, que são sempre alcançados via `order_id` e
  ganhariam zero benefício de consulta duplicando o campo (é exatamente
  o tipo de complicação desnecessária que a decisão #10 pediu pra
  evitar).

**Renovação e Entitlement — modelo escolhido:** cada `Order` aprovado e
provisionado (seja compra nova ou renovação) gera um **novo**
`Entitlement` (nunca edita um Entitlement existente — mesmo princípio de
nunca sobrescrever histórico já usado em `audit_log`/`proofs`). Uma
renovação tem `orders.renewal_of_entitlement_id` apontando pro
entitlement anterior, e o novo entitlement citado por
`orders.renewal_of_entitlement_id` de futuras renovações — encadeamento
rastreável sem precisar de coluna extra no lado do `entitlements`. A
**capacidade efetiva atual** de um usuário é a soma dos limites de todos
os `Entitlement`s com `status='active' AND expires_at > agora()` — nunca
um valor único e estático.

> **Ponto de atenção pra implementação (não bloqueia esta arquitetura):**
> hoje `users.max_bots/max_ram/max_cpu` são colunas simples, lidas
> direto por `canAddBot()`. Com múltiplos entitlements possíveis, a
> Fase 2 precisa de uma função `EntitlementManager.recomputeUserCapacity(userId)`
> que agrega os entitlements ativos e atualiza essas colunas — mantém
> `canAddBot()` funcionando sem mudança, só passa a ser alimentado por
> agregação em vez de escrita direta.

---

## 3. Máquina de estados (final, sem alterações na tabela de transições já aprovada)

```
DRAFT ──► AWAITING_PAYMENT ──► PROOF_SUBMITTED ──► UNDER_REVIEW
  │             │                                     │      │
  │ cancelar      │ expira em 2h (config)                │      │ aprova
  ▼              ▼ sem comprovante                       │      ▼
CANCELLED     EXPIRED                          recusa ◄───┘   APPROVED
                                                   │              │
                                                   ▼              ▼
                                              REJECTED        PROVISIONING
                                                                │      │
                                                     sucesso ◄──┘      └─► falha
                                                        │                    │
                                                        ▼                    ▼
                                                     ACTIVE          PROVISIONING_FAILED
                                                        │                    │
                                                   expira em 1 mês    retry (COMMERCE_STAFF/
                                                        ▼              admin) ──► PROVISIONING
                                                     EXPIRED
```

Terminais reais: `CANCELLED`, `EXPIRED` (de pedido), `REJECTED`. `ACTIVE`
é terminal do lado do `Order` (o entitlement resultante tem seu próprio
ciclo — expira separadamente, não reabre o Order). `PROVISIONING_FAILED`
é **intencionalmente não-terminal** — fica retriable indefinidamente
(decisão #14): nenhuma varredura automática o move pra outro estado;
só uma ação humana (retry, que volta pra `PROVISIONING`) o tira de lá.

**Reembolso/estorno (`REFUNDED`) não existe nesta versão** (decisão #6).
Adicionar depois é aditivo: uma nova linha na tabela de transições
válidas (ex.: `APPROVED|ACTIVE|PROVISIONING_FAILED → REFUNDED`) + colunas
nullable em `payments` (motivo, quem processou) — sem alterar o
primitivo de CAS nem nenhuma tabela existente.

**Segundo aprovador (four-eyes) não existe nesta versão** (decisão #8).
Adicionar depois é aditivo: uma coluna nullable
`payments.second_approver_id` + uma checagem extra antes da transição
final pra `APPROVED`, sem alterar a máquina de estados em si.

Tabela de transições válidas — igual à versão anterior, com o prazo de
expiração corrigido:

| De | Para | Gatilho |
|---|---|---|
| `DRAFT` | `AWAITING_PAYMENT` | Cliente confirma produto (snapshot criado) |
| `DRAFT` | `CANCELLED` | Cliente cancela antes de confirmar |
| `AWAITING_PAYMENT` | `PROOF_SUBMITTED` | Cliente envia comprovante |
| `AWAITING_PAYMENT` | `CANCELLED` | Cliente cancela |
| `AWAITING_PAYMENT` | `EXPIRED` | `CommerceScheduler`, **2h sem comprovante (default, configurável via env)** |
| `PROOF_SUBMITTED` | `UNDER_REVIEW` | COMMERCE_STAFF/admin abre o pedido |
| `UNDER_REVIEW` | `PROOF_SUBMITTED` | Pede reenvio (comprovante ilegível) |
| `UNDER_REVIEW` | `APPROVED` | Confirma pagamento (`Payment.status='confirmed'`) |
| `UNDER_REVIEW` | `REJECTED` | Recusa (motivo obrigatório) |
| `APPROVED` | `PROVISIONING` | `ProvisioningManager` inicia (assíncrono, via fila) |
| `PROVISIONING` | `ACTIVE` | Provisionamento confirmado com sucesso |
| `PROVISIONING` | `PROVISIONING_FAILED` | Falha (inclusive `BLOCKED` do ReadinessGate) |
| `PROVISIONING_FAILED` | `PROVISIONING` | Retry manual (COMMERCE_STAFF/admin) |

---

## 4. Módulos

Tudo novo em `src/managers/commerce/` (pasta isolada, mesmo padrão de
`src/managers/security/` no Kamikaze):

| Módulo | Responsabilidade | Nunca faz |
|---|---|---|
| `ProductCatalog.js` | CRUD de produtos (planos mensais); monta o snapshot imutável | Aceitar preço do cliente |
| `OrderManager.js` | Máquina de estados; **único** dono do primitivo `transitionOrder()` (CAS) | Decidir validade de pagamento; provisionar |
| `PaymentManager.js` | Expectativa de pagamento (Pix snapshotado) + confirmação humana | Marcar Entitlement/Order como `ACTIVE` |
| `ProofManager.js` | Upload, criptografia em repouso (`fileCrypto.js`), histórico, decrypt sob permissão | Decidir validade do comprovante |
| `ProvisioningManager.js` | Idempotência → `assertProvisioningAllowed()` → estratégia por produto (v1: `entitlement_only`) | Criar processo/spawn; contornar ReadinessGate/SandboxManager |
| `EntitlementManager.js` | Concede/revoga capacidade; `recomputeUserCapacity()`; expiração mensal | Ativar antes do provisionamento confirmar |
| `CommerceStaffManager.js` | Concede/revoga `COMMERCE_STAFF` (só por admin) | Conceder qualquer outro papel da hierarquia existente |
| `CouponManager.js` (adaptado) | Validação/cálculo de desconto sobre o snapshot | Referenciar `payments`/`provisioning_attempts` |
| `CommerceScheduler.js` | Varreduras periódicas: expira carrinho (2h), expira entitlement mensal, reconcilia `PROVISIONING` preso após restart | Agir fora dos managers acima |

Camada de UI: `src/handlers/domains/commerce.js` (substitui `sales.js` +
metade comercial de `admin.js`), textos em pt-BR.

---

## 5. Dependências entre módulos

```
commerce.js (UI)
   └──depende de──► OrderManager, PaymentManager, ProofManager,
                     ProvisioningManager, CommerceStaffManager,
                     CouponManager  (nunca acessa o banco direto)

OrderManager
   └──depende de──► ProductCatalog (ler snapshot na criação)
   └──depende de──► CouponManager  (calcular desconto — nunca o inverso)

PaymentManager
   └──depende de──► OrderManager (ler/checar status do pedido)
   └──NÃO depende de──✗ CouponManager, ProvisioningManager

ProofManager
   └──depende de──► fileCrypto.js (criptografia)
   └──depende de──► OrderManager (associar ao pedido certo)

ProvisioningManager
   └──depende de──► OrderManager (CAS de transição)
   └──depende de──► serviceReadiness.js (assertProvisioningAllowed — OBRIGATÓRIO)
   └──depende de──► EntitlementManager (conceder capacidade após sucesso)
   └──depende de──► queueManager.js (executar fora da interação do Discord)
   └──NÃO depende de──✗ SandboxManager direto, ✗ child_process, ✗ CouponManager

EntitlementManager
   └──depende de──► auditManager.js
   └──NÃO depende de──✗ PaymentManager, ✗ ProofManager (só sabe de Order/Entitlement)

CommerceStaffManager
   └──depende de──► userManager.js (hasPermission('admin') pra conceder/revogar)
   └──independente──  de todo o resto (só resolve "quem pode aprovar")

CommerceScheduler
   └──depende de──► OrderManager (expirar carrinho, reconciliar PROVISIONING)
   └──depende de──► EntitlementManager (expirar entitlement mensal)

Todos os módulos acima
   └──depende de──► auditManager.js (toda transição relevante — §10 do
                     rascunho anterior, mantido sem alteração)
   └──NUNCA depende de──✗ SecurityEngine.js, ✗ IncidentResponseManager.js,
                          ✗ SecurityMonitor.js
```

Este grafo é deliberadamente uma **árvore, não uma malha**: nenhum
módulo comercial depende de outro módulo comercial "de volta"
(`ProvisioningManager` depende de `OrderManager`, nunca o inverso) —
facilita testar cada um isoladamente e deixa claro onde uma mudança se
propaga.

---

## 6. Fluxo de compra

```
1.  Cliente abre carrinho (canal privado) — Order:DRAFT, guild_id capturado do canal
2.  Cliente escolhe o produto (plano mensal) — OrderManager grava
    product_snapshot, calcula total (cupom opcional, desacoplado do
    Payment) — Order:AWAITING_PAYMENT
3.  Tela de pagamento mostra os dados Pix SNAPSHOTADOS no Payment
    (nunca lidos ao vivo) — nunca aceita valor digitado pelo cliente
4.  Cliente envia comprovante dentro de 2h (senão o carrinho expira
    automaticamente) — ProofManager cifra e salva — Order:PROOF_SUBMITTED
5.  COMMERCE_STAFF ou admin abre o pedido — Order:UNDER_REVIEW (CAS
    protege contra dois revisores abrindo o mesmo pedido)
6a. Aprova → PaymentManager.confirm() → Order:APPROVED →
    ProvisioningManager.provision() enfileirado → Order:PROVISIONING
6b. Recusa (motivo obrigatório) → Order:REJECTED, cliente notificado
7.  ProvisioningManager (v1, entitlement_only):
      - idempotência + CAS pra PROVISIONING
      - assertProvisioningAllowed() — se BLOCKED, PROVISIONING_FAILED
      - concede capacidade (EntitlementManager.grant) — nunca cria bot
      - Order:ACTIVE, Entitlement:active (expires_at = +1 mês), cliente notificado
8.  Canal do carrinho fechado
```

---

## 7. Fluxo de renovação

Nunca reabre nem edita o `Order`/`Entitlement` anterior — sempre um novo
ciclo completo, encadeado por referência:

```
1.  Cliente (ou lembrete automático — fora de escopo decidir a UI exata
    aqui) inicia uma renovação do produto que já tem, referenciando o
    entitlement atual ainda ativo (ou já expirado)
2.  NOVO Order criado — mesmíssimo fluxo do §6 do zero:
    DRAFT → AWAITING_PAYMENT → PROOF_SUBMITTED → UNDER_REVIEW
    com orders.renewal_of_entitlement_id = <entitlement anterior>
3.  Aprovação e provisionamento seguem IDÊNTICOS ao fluxo de compra —
    ProvisioningManager não tem nenhuma lógica especial pra renovação,
    só cria (via EntitlementManager) um Entitlement NOVO
4.  activated_at do novo entitlement = max(agora(), expires_at do
    entitlement anterior) — uma renovação paga antes do vencimento não
    "perde" os dias restantes do plano atual. [nota: esta regra
    específica não estava nos 17 pontos decididos — proponho como
    default sensato, mas fica sinalizada como risco/ponto em aberto na
    §11]
5.  Histórico completo preservado: consultando um usuário, é possível
    ver TODOS os Orders/Payments/Entitlements de todos os meses,
    encadeados via renewal_of_entitlement_id — nunca uma única linha
    mutável representando "o plano do usuário"
```

---

## 8. Fluxo de provisionamento (ordem obrigatória, decisão #15)

```
ProvisioningManager.provision(orderId):

  ── PASSO 1: VALIDAÇÃO + IDEMPOTÊNCIA (sempre primeiro, sem exceção) ──
  1a. Relê Order + Entitlement atuais.
      Se já existe Entitlement 'active' pra este orderId → retorna
      sucesso imediatamente (no-op). NUNCA reprocessa.
  1b. Valida que Order.status ∈ {APPROVED, PROVISIONING_FAILED} — fora
      disso, rejeita a chamada como uso inválido (erro de programação/
      chamada fora de hora), nunca prossegue.
  1c. transitionOrder(orderId, ['APPROVED','PROVISIONING_FAILED'],
      'PROVISIONING') — CAS atômico. Se falhar (outro processo/retry
      concorrente já pegou), retorna sem fazer nada.

  ── PASSO 2: GATE DE SEGURANÇA (só depois do Passo 1 confirmar que
     faz sentido prosseguir) ──
  2a. assertProvisioningAllowed('provisionamento comercial: pedido
      #<id>') — se o serviço estiver BLOCKED, lança aqui. Vai pra
      PROVISIONING_FAILED. NUNCA cai pra um caminho alternativo.

  ── PASSO 3: EXECUÇÃO (sempre via pontos de entrada existentes) ──
  3a. strategy = strategies[order.product_snapshot.provisioning_type]
      — v1: SEMPRE 'entitlement_only'. Nenhuma estratégia da v1 cria
      processo, chama SandboxManager, ou toca em `bots.*`.
  3b. result = strategy.execute(order)  — v1: só calcula os limites
      concedidos a partir do snapshot, não escreve nada ainda.
  3c. EntitlementManager.grant(orderId, result) — cria o Entitlement,
      chama recomputeUserCapacity(userId).
  3d. transitionOrder(orderId, ['PROVISIONING'], 'ACTIVE').

  QUALQUER FALHA (2a ou 3): captura, transitionOrder(...,
  'PROVISIONING_FAILED'), grava em provisioning_attempts, audita,
  alerta o time via alertManager. Pagamento PERMANECE 'confirmed'
  (decisão #14) — nunca é revertido automaticamente, e o Order continua
  visível numa fila própria de "falhas de provisionamento" pra retry
  manual.
```

Execução sempre dentro de `queueManager.js` (nunca inline na interação
do Discord) — mesmo padrão não-bloqueante já usado pelo
`SecurityMonitor.js` na Fase 2.

**Invariante de spawn (decisão #16):** nenhum arquivo em
`src/managers/commerce/` importa `child_process` nem chama
`spawn`/`exec`/`fork`. Se uma estratégia futura precisar iniciar um
bot de verdade, o único caminho permitido é
`processManager.startBot()` — que já decide isolamento via
`SandboxManager` internamente. Este documento reserva esse ponto de
integração (§1) mas não o implementa: a v1 nunca o alcança.

---

## 9. Matriz de permissões

Duas camadas, preservando o modelo dual já existente na plataforma:

1. **Nativa do Discord** — quem vê/usa o canal e o comando de revisão
   (permissão de canal, papel Discord configurado).
2. **Interna da aplicação** — checada dentro de cada handler, via nova
   função `hasCommercePermission(userId, action)`:
   ```
   hasCommercePermission(userId, action) =
       hasPermission(userId, 'admin')          // admin sempre pode tudo
       OR isActiveCommerceStaff(userId)         // COMMERCE_STAFF concedido
   ```
   Sem granularidade por `action` na v1 (existe só uma ação real:
   aprovar/recusar pagamento) — o parâmetro já existe na assinatura pra
   permitir diferenciar ações no futuro (ex.: um dia, "aprovar valor
   alto" vs. "aprovar valor normal", ligado ao four-eyes da decisão #8)
   sem quebrar quem já chama a função.

   `moderator` **não** herda permissão comercial automaticamente — só
   quem é `admin` ou tem `COMMERCE_STAFF` concedido explicitamente
   (decisão #7 pede uma alternativa a `Administrator`, não uma expansão
   pra `moderator`).

| Ação | Cliente (dono do pedido) | COMMERCE_STAFF | Admin |
|---|---|---|---|
| Criar carrinho / escolher produto / aplicar cupom | ✅ (o próprio) | — | — |
| Enviar comprovante | ✅ (o próprio) | — | — |
| Cancelar o próprio pedido (antes de `UNDER_REVIEW`) | ✅ (o próprio) | — | ✅ |
| Ver fila de pedidos em análise / falhas de provisionamento | ❌ | ✅ | ✅ |
| Abrir pedido pra revisão (`UNDER_REVIEW`) | ❌ | ✅ | ✅ |
| Aprovar / recusar pagamento | ❌ | ✅ | ✅ |
| Ver / decriptar comprovante | ❌ | ✅ | ✅ |
| Retry de provisionamento (`PROVISIONING_FAILED`) | ❌ | ✅ | ✅ |
| Conceder / revogar `COMMERCE_STAFF` | ❌ | ❌ | ✅ |
| Editar catálogo de produtos (`ProductCatalog`) | ❌ | ❌ | ✅ |
| Configurar dados Pix | ❌ | ❌ | ✅ |
| Ajustar prazos (expiração de carrinho, retenção de comprovante) | ❌ | ❌ | ✅ |

---

## 10. Invariantes de segurança (verificáveis, não só declaradas)

Cada uma abaixo é estruturalmente garantida pela arquitetura (não
depende de um desenvolvedor "lembrar" de checar) — na Fase 2, cada uma
vira um teste adversarial dedicado, mesmo padrão da revisão do
SecurityMonitor:

1. **Nenhum caminho leva a `Entitlement.status='active'` sem passar por
   `ProvisioningManager` com `assertProvisioningAllowed()` já
   confirmado** — `EntitlementManager.grant()` só é chamado de dentro do
   Passo 3 do §8, nunca diretamente por `PaymentManager`/`commerce.js`.
2. **Nenhum código em `src/managers/commerce/` importa `child_process`
   nem chama `SandboxManager` diretamente** — checável por grep
   estrutural, mesmo padrão usado na revisão da Fase 2.
3. **Nenhum código em `src/managers/commerce/` importa
   `SecurityEngine.js`, `IncidentResponseManager.js` ou
   `SecurityMonitor.js`** — Kamikaze continua completamente cego ao
   comercial, em ambas as direções.
4. **Preço nunca é aceito como input do cliente** — sempre derivado de
   `products` pelo ID interno, e uma vez copiado pro `order.product_snapshot`,
   nunca mais recalculado a partir do produto "ao vivo".
5. **`orders.status` só muda através do CAS de `OrderManager`** —
   nenhuma outra parte do sistema executa `UPDATE orders SET status=...`
   diretamente.
6. **`payments`/`provisioning_attempts` nunca referenciam `coupon_id`**
   — cupom só existe na precificação do `Order` (decisão #11).
7. **Um comprovante nunca é gravado em texto puro em disco** — sempre
   via `fileCrypto.encryptBuffer()` antes de qualquer `fs.writeFileSync`.
8. **Falha de provisionamento nunca reverte o pagamento
   automaticamente** — `PROVISIONING_FAILED` nunca dispara nenhuma
   lógica de estorno (que nem existe na v1).
9. **`hasCommercePermission` é checada dentro do manager, não só na UI**
   — mesmo padrão defensivo de `canManageBot()`.

---

## 11. Riscos restantes

Levados adiante da versão anterior (ainda válidos) + os que surgem
diretamente das decisões desta rodada:

- **Comprovante falsificado** — v1 depende de revisão humana, sem
  validação automática de extrato bancário. Risco aceito e explícito.
- **Exposição do comprovante ao ser exibido no Discord pra revisão** —
  inerente à restrição "100% dentro do Discord", mitigação só
  procedimental (canal restrito a `COMMERCE_STAFF`/admin).
- **Compromisso de conta com `COMMERCE_STAFF`** — poder de aprovar
  pagamento sem ser `admin` pleno. Mitigado por: concessão só por admin,
  auditoria completa de quem aprovou o quê, soft-revoke (histórico de
  quem teve o papel e quando). Sem four-eyes na v1 (decisão #8) — risco
  aceito explicitamente, extensão fica pronta pra quando for pedida.
- **Renovação antecipada + `activated_at = max(agora, expiração
  anterior)`** — regra proposta no §7 que não estava nos 17 pontos
  decididos; precisa de confirmação explícita antes da Fase 2 (ou
  aceitar o default proposto).
- **Ausência de reembolso automatizado + falha permanente de
  provisionamento** — o pedido fica indefinidamente em
  `PROVISIONING_FAILED` até ação humana; sem um prazo/alerta de
  escalonamento definido, um pedido preso pode passar despercebido.
  Proposta pra Fase 2 (não bloqueia esta arquitetura): a fila de "falhas
  de provisionamento" (mesmo padrão de "pedidos em análise") já resolve
  a visibilidade — nenhum mecanismo automático adicional é necessário
  na v1.
- **`guild_id` nullable em `products`/`commerce_staff`** — como a v1 é
  single-guild, um valor nulo/errado nunca é exercitado de verdade;
  o primeiro uso real multi-guild (fora de escopo) exigirá validação
  adicional não coberta por testes da v1.
- **Cálculo agregado de capacidade (`recomputeUserCapacity`)** —
  correto o suficiente pra v1 (planos mensais, um produto por vez na
  prática), mas não foi pensado pra um cliente acumulando múltiplos
  planos simultâneos de produtos diferentes com regras de composição
  distintas — se isso vier a ser um caso real, precisa de uma regra de
  negócio explícita (soma? maior valor? não permitido?) antes de
  implementar.
- **Nenhum relatório financeiro/dashboard** — condizente com "sem
  dashboard web", mas significa que toda reconciliação financeira
  depende de consultas manuais/comandos dentro do Discord.

---

**Parando aqui, conforme instruído.** Arquitetura final apresentada
acima. Nenhum arquivo de implementação foi criado ou modificado.
Aguardando aprovação para iniciar a Fase 2 (implementação).
