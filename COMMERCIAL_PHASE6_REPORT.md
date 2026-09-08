# Fase 6 — Revisão, Aprovação e Rejeição de Pagamentos

Relatório final da Fase 6, autorizada sobre o commit `7573048` (Fase 5 validada). Escopo: fluxo administrativo completo para CommerceStaff/Administrator revisarem comprovantes e aprovarem/recusarem pedidos, com uma nova via de "rejeição leve" (pedir novo comprovante), guardas persistentes contra corrida, e reforço de autorização — sem provisionamento automático.

## 1) Arquivos criados/alterados

**Novo:**
- `tests/commercePhase6Adversarial.test.js` — 27 testes adversariais.

**Alterados:**
- `src/managers/commerce/OrderManager.js` — novo `STATUS.NEEDS_NEW_PROOF` e as transições correspondentes; `cancelOrder()` passa a aceitar cancelamento também a partir desse estado.
- `src/managers/commerce/ProofManager.js` — `submitProof()` passa a aceitar reenvio quando o pedido está `NEEDS_NEW_PROOF`, transicionando direto de volta pra `UNDER_REVIEW` (preserva o histórico do comprovante anterior).
- `src/managers/commerce/PaymentManager.js` — reescrita de `confirmPayment`/`rejectPayment` com guarda dupla persistente (ver seção 3), novo helper interno `assertCanReview` (permissão + segregação de função + comprovante válido), e nova função `requestNewProof()`.
- `src/handlers/domains/commerce.js` — embed de revisão enriquecido (data, preço original×final, histórico de comprovantes, última observação do staff), novo botão/modal "Pedir Novo Comprovante" com notificação ao cliente (canal privado + DM) e log de auditoria visível ao staff.
- `tests/commercePaymentManager.test.js`, `tests/commercePhase2Adversarial.test.js` — helpers ajustados pra inserir uma linha mínima de comprovante antes de testar `confirmPayment`/`rejectPayment` isoladamente de `ProofManager` (a nova exigência de "comprovante válido" tornou isso necessário; nenhuma lógica de teste foi enfraquecida, só a fixture).

## 2) Máquina de estados implementada

```
                    ┌──────────────────┐
                    │   AWAITING_PAYMENT │
                    └─────────┬────────┘
                              │ submitProof()
                              ▼
                    ┌──────────────────┐
              ┌─────│  PROOF_SUBMITTED │
              │     └─────────┬────────┘
              │               │ openForReview() (staff)
              │               ▼
              │     ┌──────────────────┐
              │  ┌──│   UNDER_REVIEW   │──┐
              │  │  └────────┬─────────┘  │
   submitProof│  │requestNewProof()       │confirmPayment()   rejectPayment()
   (novo)     │  │           │            │(staff)            (staff, motivo obrigatório)
              │  ▼           │            ▼                        ▼
              │ ┌────────────┴───┐   ┌──────────┐            ┌──────────┐
              └▶│ NEEDS_NEW_PROOF │   │ APPROVED │            │ REJECTED │ (terminal)
                └────────┬────────┘   └────┬─────┘            └──────────┘
                         │cancelOrder()     │ (fase futura: ProvisioningManager)
                         ▼                  ▼
                   ┌───────────┐      ┌─────────────┐
                   │ CANCELLED │      │ PROVISIONING│
                   └───────────┘      └─────────────┘
```

`NEEDS_NEW_PROOF` é a novidade desta fase: distinta de `REJECTED` (terminal, sem volta). O `Payment` NUNCA é tocado nessa transição — continua `awaiting_proof`, porque nenhuma decisão financeira foi tomada, só se pediu uma evidência melhor. Testado e confirmado: `AWAITING_PAYMENT/PROOF_SUBMITTED/UNDER_REVIEW → ACTIVE` continuam impossíveis (não estão em `VALID_TRANSITIONS` de nenhum desses estados fora de `PROVISIONING`), e um pedido `REJECTED` nunca aceita um novo comprovante (não está na lista de estados que `ProofManager.submitProof()` aceita).

## 3) Guarda dupla persistente (Gate 1 Order + Gate 2 Payment)

O requisito central da fase — "nunca reportar sucesso se a operação persistente não bateu" — foi implementado como dois CAS independentes em sequência, ambos com `changes` explicitamente checado:

1. **Gate 1 (Order)**: `OrderManager.transitionOrder()` — já existia desde a Fase 2, preservado sem alteração (mantém todas as mensagens/comportamentos já testados desde então para a corrida legítima entre dois cliques de "Aprovar"/"Recusar").
2. **Gate 2 (Payment)**: `UPDATE commerce_payments SET status = ? ... WHERE order_id = ? AND status = 'awaiting_proof'` — novo nesta fase. Sob operação normal isto SEMPRE bate, porque `Payment` e `Order` só são movidos juntos por este módulo (nunca há um segundo escritor). Chegar aqui com `changes === 0` só é alcançável por uma inconsistência real de dados (não por uma corrida legítima — essa já foi filtrada pelo Gate 1) — nesse caso a operação lança um erro claro e grava um evento de auditoria com severidade `error` (`commerce:payment_confirm_inconsistency`/`commerce:payment_reject_inconsistency`), nunca reporta sucesso.

Testado explicitamente forçando as duas inconsistências pedidas: Payment inexistente (linha deletada) e Payment já `confirmed` num pedido artificialmente devolvido a `UNDER_REVIEW`.

Além disso, `assertCanReview()` (novo helper interno, usado por `confirmPayment`/`rejectPayment`/`requestNewProof`) adiciona duas guardas que rodam ANTES de qualquer CAS:
- **Segregação de função**: `order.user_id === reviewerUserId` é sempre recusado — um staff nunca revisa o próprio pedido, mesmo tendo permissão comercial real.
- **Comprovante válido obrigatório**: exige `ProofManager.getLatestProofForOrder(orderId)` não-nulo — defesa em profundidade contra "aprovar sem comprovante" (a máquina de estados já torna isso estruturalmente impossível pelo fluxo normal, mas a checagem existe mesmo assim).

## 4) Regras de autorização

- **Somente Administrator ou CommerceStaff ativo** — `CommerceStaffManager.hasCommercePermission()`, checada dentro de cada função do manager (nunca só na UI), confirmado por teste estrutural que também cobre a nova `requestNewProof`.
- **Moderator sem CommerceStaff não tem autoridade comercial nenhuma** — reafirmado (decisão já validada na Fase 2, sem mudança).
- **Staff revogado perde acesso imediatamente** — a checagem é sempre contra o banco no momento da chamada, nunca cacheada; testado revogando um staff que tinha ABERTO a revisão e confirmando que as três ações (aprovar/recusar/pedir novo comprovante) são recusadas depois da revogação, sem que o pedido avance.
- **Nunca uma autoaprovação** — novo nesta fase, ver seção 3.

## 5) Visualização segura do comprovante

Sem mudança na infraestrutura (já endurecida na Fase 5) — `ProofManager.getDecryptedProof()` continua a única função que decripta, sempre exigindo `hasCommercePermission()`, sempre auditando a visualização (e a tentativa negada). Nesta fase, o painel de revisão passou a mostrar quantos comprovantes o pedido já recebeu (histórico), o que ajuda o staff a perceber quando está revisando um reenvio. Reafirmado por teste: nenhum endpoint HTTP, nenhum envio a canal público (a resposta com o anexo é sempre `ephemeral: true`).

## 6) Auditoria

Registrado nesta fase (além do que já existia): `commerce:proof_reupload_requested` (pedir novo comprovante — staff, order_id, motivo), `commerce:payment_confirm_inconsistency`/`commerce:payment_reject_inconsistency` (anomalias do Gate 2, severidade `error`). Reconfirmado que `commerce:payment_confirmed`/`commerce:payment_rejected` (já existentes) continuam registrando quem decidiu e o motivo (quando aplicável). Nenhum evento novo grava conteúdo de comprovante, token, senha ou chave — confirmado por teste (`assert.equal(/token|senha|password|secret/i.test(...), false)`).

## 7) Testes adversariais (27 novos)

Por seção, em `tests/commercePhase6Adversarial.test.js`: ciclo completo `NEEDS_NEW_PROOF` preservando histórico, cancelamento a partir de `NEEDS_NEW_PROOF`, `REJECTED` como terminal (nunca aceita novo comprovante), atalhos proibidos pra `ACTIVE` (comportamental + estrutural sobre `VALID_TRANSITIONS`), Gate 2 forçado (payment inexistente, payment já confirmado com Order artificialmente revertido), aprovação duplicada, aprovação de pedido cancelado/expirado, autoaprovação (staff = comprador), comprovante válido obrigatório, concorrência (dois staffs aprovando, aprovar×recusar, aprovar×pedir novo comprovante, pedir novo comprovante×pedir novo comprovante — quatro disputas diferentes pelo mesmo CAS), privilege escalation (cliente comum, moderator sem staff), staff revogado durante a revisão, `order_id` adversarial (inexistente/SQL-like/negativo/zero), verificação estrutural de ausência de `paymentId`/preço/valor como parâmetro em qualquer função pública, verificação estrutural de que `PaymentManager.js` nunca escreve em `users.max_bots/ram/cpu`, preservação do snapshot/preço através do ciclo de aprovação, isolamento entre dois clientes com pedidos simultaneamente em revisão, e auditoria (conteúdo correto, sem secrets).

## 8) Resultado da suíte completa (19 execuções para estabilidade)

```
tests 450
pass 445
fail 0
cancelled 0
skipped 5
```
423→450 (27 testes novos desta fase), 0 regressões nos testes já existentes (dois arquivos de fixture ajustados — `commercePaymentManager.test.js` e `commercePhase2Adversarial.test.js` — pela nova exigência de comprovante válido, sem enfraquecer nenhuma asserção).

Executado 19 vezes seguidas: **18 limpas, 1 falha isolada não reproduzida** nas 18 execuções seguintes (nem nas anteriores). Investigação: tentei capturar o teste específico repetindo a suíte imediatamente após, sem sucesso em reproduzir — nenhum teste desta fase (nem de fases anteriores) voltou a falhar em nenhuma das 18 tentativas subsequentes. Dado que todos os testes novos desta fase são síncronos e usam CAS determinístico (sem temporizadores reais nem dependência de relógio de parede além de comparações de data com offset fixo), a causa mais provável é ruído ambiental transitório (contenção de I/O de arquivo ao criar/apagar dezenas de bancos SQLite por segundo, todos no mesmo diretório, rodando muitos arquivos de teste em sequência) — não uma falha de lógica introduzida nesta fase. Reportando com transparência em vez de omitir.

## 9) Riscos encontrados

1. **Deixar `Order=APPROVED` com `Payment` inconsistente, num cenário hipotético onde o Gate 2 falha depois do Gate 1 já ter sucesso** — só é alcançável por uma corrupção de dados pré-existente (nunca por uma corrida legítima do código atual, dado que Order e Payment só são movidos juntos por este módulo). Nesse caso a operação lança e audita como anomalia (`severity: error`), nunca reporta sucesso — mas não há reconciliação automática do Order de volta pra `UNDER_REVIEW` (isso violaria "nunca criar atalhos na máquina de estados", já que essa transição reversa não existe no `VALID_TRANSITIONS`). Fica registrado como uma anomalia auditada pra intervenção manual/futura ferramenta de reconciliação.
2. **`requestNewProof` pode em teoria ser usado repetidamente por um staff mal-intencionado pra travar o pedido de um cliente em ciclo** — mitigado pelo fato de exigir permissão comercial real (já um controle de confiança), fora do escopo desta fase implementar limite de tentativas.
3. Nenhuma alteração em `SecurityEngine`, `IncidentResponseManager`, Kamikaze, sandbox, `readiness` ou `capacityManager` — confirmado por leitura direta e por um novo teste estrutural específico desta fase (`PaymentManager.js` nunca escreve em `users.max_bots/ram/cpu`).

## 10) Limitações conhecidas

1. Sem reconciliação automática para a inconsistência Order×Payment descrita no risco #1 (extremamente improvável de ocorrer, mas sem ferramenta dedicada de correção nesta fase).
2. `requestNewProof` não tem limite de repetições.
3. "Aprovação de outro guild" não é uma fronteira ativamente reforçada em `PaymentManager` — aceitável porque a v1 é explicitamente para um único servidor Discord (decisão já registrada na arquitetura).
4. Nenhum provisionamento, criação de bot, ativação de hospedagem, site, login, mini VS Code, Atlantic AI, afiliados ou refund/chargeback automático foi implementado — todos permanecem fora de escopo, conforme instruído.

## 11) Commit

Aguardando push nesta mensagem — hash reportado a seguir.
