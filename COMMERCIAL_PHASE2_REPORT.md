# COMMERCIAL_PHASE2_REPORT.md — Fase 2 (implementação): dados + regras de negócio

Status: **Implementado, testado, suíte completa em 0 falhas. Aguardando
aprovação para a Fase 3.** Não avancei automaticamente.

Escopo desta fase, conforme instruído: migrações/tabelas, `ProductCatalog`,
`OrderManager`, `PaymentManager`, `EntitlementManager`,
`CommerceStaffManager`, `CouponManager`, `CommerceScheduler`. **Não**
implementado (por instrução explícita): painel Discord, fluxo público de
compra, comprovantes (`ProofManager`), aprovação via UI, e
`ProvisioningManager` além dos contratos que os outros módulos já expõem
pra ele consumir depois.

As duas decisões finais foram aplicadas exatamente como especificado:
1. `activated_at = max(agora, expires_at do entitlement anterior)` —
   renovação antecipada preserva os dias pagos; renovação após expiração
   começa imediatamente (mesma fórmula cobre os dois casos).
2. Um usuário nunca acumula múltiplos entitlements de hospedagem
   simultaneamente na v1 — garantido estruturalmente em
   `EntitlementManager.grant()` (nunca por convenção), com teste
   dedicado provando que uma segunda concessão não-renovação é recusada.

---

## Arquivos criados

**Módulos** (`src/managers/commerce/`, pasta nova):
- `ProductCatalog.js` — CRUD de produtos + `buildProductSnapshot()`.
- `OrderManager.js` — máquina de estados completa, `transitionOrder()`
  (CAS atômico, único primitivo de mudança de status).
- `PaymentManager.js` — registro de pagamento (Pix snapshotado),
  `openForReview`/`confirmPayment`/`rejectPayment`.
- `EntitlementManager.js` — `grant()` (idempotente, invariante de não
  acumulação, fórmula de renovação), `recomputeUserCapacity()`,
  `expireEntitlement()`, `revokeEntitlement()`.
- `CommerceStaffManager.js` — `COMMERCE_STAFF` (grant/revoke só por
  admin, soft-revoke), `hasCommercePermission()`.
- `CouponManager.js` — `validateCoupon`/`calculateDiscount`/
  `confirmUsage` (reaproveita a tabela `coupons` existente).
- `CommerceScheduler.js` — `sweepExpiredCarts`, `sweepExpiredEntitlements`,
  `reconcileStuckProvisioning`, `start/stopCommerceScheduler` (não
  ligado em `index.js` nesta fase — ver "Riscos e observações").

**Testes** (`tests/`, 8 arquivos novos, 98 testes):
`commerceProductCatalog.test.js` (10) · `commerceOrderManager.test.js`
(15) · `commercePaymentManager.test.js` (9) ·
`commerceEntitlementManager.test.js` (17) · `commerceStaffManager.test.js`
(10) · `commerceCouponManager.test.js` (11) · `commerceScheduler.test.js`
(9) · `commercePhase2Adversarial.test.js` (17, invariantes estruturais
cross-módulo).

**Documentação:** este arquivo.

## Arquivos alterados

- `src/database/database.js` — 5 tabelas novas (ver "Migrações" abaixo)
  + 3 índices. Nenhuma tabela existente foi alterada.
- `config.js` — nova seção `commerce.cartExpirationHours` (default 2,
  configurável via `COMMERCE_CART_EXPIRATION_HOURS`).
- `package.json` — 8 scripts `test:commerce*` novos + `test:ci`
  estendido com os 8 arquivos novos.

**Confirmado não alterado** (checado via `git status`/`git diff` antes
de reportar): nenhum arquivo em `src/managers/security/`, nenhum arquivo
de sandbox, `index.js` não tocado (o scheduler não foi ligado ao boot
nesta fase — ver riscos).

---

## Migrações (tabelas novas)

Todas com prefixo `commerce_` — deliberadamente isoladas do sistema de
vendas legado (`plans`/`orders`/`sales_config`, que continuam existindo
e funcionando em paralelo, sem nenhuma relação com as tabelas novas
exceto `coupons`, reaproveitada como está).

| Tabela | Papel | FKs |
|---|---|---|
| `commerce_products` | Catálogo (planos mensais) | — |
| `commerce_orders` | Pedido + máquina de estados + `product_snapshot` imutável | `user_id→users`, `product_id→commerce_products`, `coupon_id→coupons`, `renewal_of_entitlement_id→commerce_entitlements` |
| `commerce_payments` | Expectativa de pagamento (Pix snapshotado) + veredito | `order_id→commerce_orders` (1:1, UNIQUE), `confirmed_by_admin_id→users` |
| `commerce_entitlements` | Capacidade concedida, 1:1 com `commerce_orders` | `order_id→commerce_orders` (UNIQUE), `user_id→users` |
| `commerce_staff` | Grant/revoke de `COMMERCE_STAFF` | `user_id/granted_by/revoked_by→users` |

Simplificações feitas em relação ao rascunho de arquitetura (removem
colunas redundantes, sem perder nenhuma garantia): `orders.version`
removido (o CAS por `status` já garante concorrência segura sozinho);
`entitlements.product_snapshot_ref` removido (lê sempre via
`order_id→product_snapshot`, uma única fonte de verdade);
`orders.order_type` removido (derivável de
`renewal_of_entitlement_id IS NOT NULL`).

`coupons` — **nenhuma coluna nova**, reaproveitada tal como está.

Índices: `idx_commerce_orders_user_status`, `idx_commerce_orders_status`,
`idx_commerce_entitlements_user_status`.

---

## Testes (98 novos, todos passando)

Cobertura por módulo, com destaque pros casos mais sensíveis:

- **ProductCatalog** (10): snapshot imutável mesmo após edição/arquivamento
  do produto; `billing_period` restrito a `'monthly'`; preço nunca
  negativo/não-numérico.
- **OrderManager** (15): máquina de estados percorrida ponta a ponta
  (DRAFT→...→ACTIVE); transição fora da tabela válida lança (erro de
  programação) vs. corrida perdida retorna `null` (nunca lança); **CAS
  sob concorrência** (duas transições disputando o mesmo pedido, só uma
  vence); preço nunca vem de parâmetro externo; cupom recalcula sempre a
  partir do snapshot; cancelamento bloqueado a partir de `UNDER_REVIEW`.
- **PaymentManager** (9): `confirmPayment` leva só até `APPROVED`, nunca
  `ACTIVE`; permissão checada dentro do manager (não só na UI); Pix
  snapshotado imune a mudança posterior de `sales_config`; cupom
  incrementado só na confirmação; dupla aprovação — só a primeira
  funciona.
- **EntitlementManager** (17) — o módulo mais sensível desta fase:
  `grant()` recusa se `Order` não está em `PROVISIONING`; idempotência
  (chamar duas vezes retorna o mesmo entitlement); **renovação antecipada
  preserva os dias restantes** (`activated_at` ≈ `expires_at` do
  anterior, não "agora"); **renovação após expiração começa
  imediatamente**; **segunda compra (não-renovação) com entitlement já
  ativo é recusada** (`EntitlementConflictError`); renovação nunca aceita
  um entitlement de outro usuário, nem um revogado, nem um que não seja o
  atual; `getActiveEntitlement` detecta e lança se alguma vez encontrar
  mais de um `active` (violação de integridade, nunca escolhe um
  silenciosamente); teto de segurança do host sempre respeitado mesmo se
  o produto pedir mais.
- **CommerceStaffManager** (10): só admin concede/revoga; moderator não
  herda automaticamente; soft-revoke preserva histórico; idempotente.
- **CouponManager** (11): mesma lógica já validada em produção do
  legado; revalidação de limite na CONFIRMAÇÃO, não na aplicação (mesma
  classe de bug já corrigida uma vez no fluxo antigo, preservada aqui).
- **CommerceScheduler** (9): expira carrinho após o prazo configurável
  (nunca antes); expira entitlement vencido; reconcilia pedido preso em
  `PROVISIONING` (nunca resume às cegas).
- **Adversarial cross-módulo** (17): ver seção seguinte.

Dois test-authoring bugs foram encontrados e corrigidos DURANTE a
escrita dos testes (nunca um bug de implementação real) — documentados
aqui por transparência: (1) um teto de RAM/CPU default do host (512MB)
fazia um teste de capacidade "esperar" um valor que na verdade deveria
ser clamped — corrigido usando valores de teste abaixo do teto; (2) uma
checagem estrutural por proximidade textual no arquivo (regex de 200
caracteres) dava falso positivo — corrigida para extrair e checar a
string SQL literal exata, não uma janela de texto ao redor dela.

---

## Invariantes cobertas (verificáveis, não só declaradas)

Todas testadas com evidência de código, mesmo padrão da revisão
adversarial da Fase 2 do Kamikaze:

1. **Nenhum módulo em `src/managers/commerce/` importa `child_process`,
   `SandboxManager`, `SecurityEngine`, `IncidentResponseManager`,
   `SecurityMonitor` ou `processManager`** — checado por grep estrutural
   sobre os arquivos reais, não apenas por comentário.
2. **`commerce_orders.status` só muda via `OrderManager.transitionOrder()`**
   — nenhum outro arquivo do módulo comercial escreve `UPDATE
   commerce_orders SET status=` diretamente (grep estrutural).
3. **Cupom nunca referenciado por `commerce_payments`** — nem como
   coluna no schema, nem em nenhuma instrução SQL do `PaymentManager.js`.
4. **Preço nunca aceito como parâmetro de fora** — nenhuma função pública
   de `OrderManager` tem `price`/`amount`/`valor` na assinatura; sempre
   derivado de `ProductCatalog` pelo ID.
5. **Pagamento confirmado ≠ Entitlement ativo** — `confirmPayment()`
   nunca cria um `Entitlement` (nem importa `EntitlementManager`);
   testado que depois de confirmar, nenhuma linha existe em
   `commerce_entitlements` pro pedido.
6. **`hasCommercePermission` checada dentro do manager** — checado tanto
   por leitura de código (toda função sensível de `PaymentManager`
   chama a função) quanto funcionalmente (negação nunca muda nenhum
   estado, nem parcialmente).
7. **Snapshot imutável** — editar ou arquivar um produto depois de um
   pedido confirmado nunca altera o pedido já existente.
8. **Não acumula múltiplos entitlements simultâneos** — testado
   diretamente e num cenário de ponta a ponta com dois pedidos aprovados
   "em paralelo" pro mesmo usuário.
9. **Renovação com fórmula `max(agora, expiração anterior)`** — os dois
   casos (antecipada e após expirar) testados com margem de tolerância
   de tempo.
10. **Concorrência (CAS)** — duas transições disputando o mesmo pedido,
    só uma vence, nunca lança por "perder a corrida".
11. **Robustez contra IDs adversariais** — `userId` com sintaxe
    SQL-like nunca quebra o pipeline nem afeta outras tabelas (proteção
    estrutural das queries parametrizadas, comprovada por teste real).

---

## Resultados da suíte

```
Só os testes novos desta fase (8 arquivos, executados juntos, 3x seguidas):
  98 testes, 98 passando, 0 falhas — estável nas 3 execuções

Suíte completa (npm test, 2x seguidas):
  317 testes, 312 passando, 0 falhas, 5 skips — estável nas 2 execuções
  (baseline anterior de 219 + 98 novos desta fase)

npm run test:ci:
  303 testes, 300 passando, 0 falhas, 3 skips
```

Nenhuma regressão em nenhum teste pré-existente — Kamikaze e
SecurityMonitor (Fase 2 já aprovada) permanecem exatamente como estavam,
confirmado tanto pelos resultados quanto por `git status`/`git diff`
(nenhum arquivo de segurança/sandbox aparece como alterado).

---

## Riscos encontrados / observações

Nenhum é um bug de segurança — são decisões de escopo e pontos que a
próxima fase precisa levar em conta:

1. **`recomputeUserCapacity` escreve em `users.max_bots/max_ram/max_cpu`
   — as MESMAS colunas que o sistema de vendas LEGADO também escreve**
   (via `activateUserPlan()`, ainda ativo e funcionando em paralelo).
   Não há conflito nesta fase (nada além dos testes chama
   `EntitlementManager.grant()` ainda, já que não há painel/fluxo público
   de compra), mas quando a Fase 3 (`ProvisioningManager` + UI) for
   construída, os dois sistemas escrevendo na mesma coluna
   simultaneamente em produção precisará de uma decisão explícita (migrar
   o legado pro novo sistema, ou definir qual "vence"). Não é um problema
   HOJE — é um risco de uma fase futura, registrado aqui pra não pegar
   ninguém de surpresa.
2. **`CommerceScheduler` não está ligado a `index.js`** — por instrução
   explícita (não implementar painel/fluxo público), e porque não faria
   sentido rodar varreduras periódicas contra um sistema que ainda não
   tem nenhum jeito de gerar pedidos reais em produção. `start/stop` já
   existem e são testados; ligar `startCommerceScheduler()` no boot fica
   pra quando a interface do Discord também for ligada.
3. **`grant()` marca o entitlement anterior como `'expired'` no momento
   da renovação, mesmo numa renovação antecipada** (antes do
   `expires_at` real ter passado) — decisão de design deliberada,
   documentada no código e nos testes: simplifica o modelo (nunca duas
   linhas `'active'` simultâneas) sem perder nenhuma capacidade (o novo
   entitlement começa exatamente onde o antigo pararia).
4. **Nenhum `ProvisioningManager.js` foi criado** — por instrução
   explícita. O "contrato" que a Fase 3 vai consumir já existe e está
   testado: `OrderManager.transitionOrder(orderId, ['APPROVED'],
   'PROVISIONING')` e depois `EntitlementManager.grant(orderId)` (que já
   valida que o pedido está em `PROVISIONING` antes de agir). A Fase 3
   só precisa orquestrar essas duas chamadas em torno de
   `assertProvisioningAllowed()`, na ordem já especificada na
   arquitetura aprovada.
5. **Formato de data**: `activated_at`/`expires_at` são armazenados no
   mesmo formato de string que `datetime('now')` do SQLite produz (UTC,
   sem milissegundos) — permite comparação direta em SQL
   (`CommerceScheduler`) sem risco de fuso horário. Documentado nos
   comentários de `EntitlementManager.js` (`toSqliteDatetime`/
   `fromSqliteDatetime`) porque é uma armadilha real do JS (`new
   Date('YYYY-MM-DD HH:MM:SS')` sem `Z` pode ser interpretado como
   horário LOCAL em vez de UTC) — vale a pena qualquer código futuro que
   mexer nessas colunas seguir o mesmo padrão.
6. **Aritmética de "+1 mês"** usa `setUTCMonth` do JS — em datas como 31
   de janeiro, o rollover de mês mais curto (fevereiro) segue o
   comportamento padrão do JS (ex.: 31/jan + 1 mês pode virar 2 ou 3 de
   março, não 28/fev). Não documentado como requisito de negócio
   específico — assunção razoável e comum, mas sinalizada aqui caso a
   regra de cobrança precise de "sempre o mesmo dia do mês, clampado no
   fim do mês" no futuro.

---

## Documentos relacionados

- `COMMERCIAL_ARCHITECTURE_PROPOSAL.md` — arquitetura aprovada que esta
  fase implementa.
- `SECURITY_MONITOR.md` / `SECURITY_MONITOR_REVIEW.md` — Fase 2 do
  Kamikaze, confirmada inalterada por esta fase.

**Parando aqui, conforme instruído.** Não avancei pra Fase 3
(`ProvisioningManager` real + painel Discord). Aguardando aprovação.
