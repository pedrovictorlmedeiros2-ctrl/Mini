# Fase 4 — Fluxo Público de Compra no Discord

Relatório final da Fase 4, autorizada sobre o commit `b4e83bd` (Fase 3 validada). Escopo: endurecer e completar o fluxo público de compra já construído na Fase 3 — painel de planos, seleção/confirmação com snapshot imutável, canal privado do pedido, pagamento via Pix, envio de comprovante, e a correção da fricção operacional de staff documentada como risco na Fase 3. Todas as invariantes das fases anteriores foram preservadas sem exceção (ver seção 6).

## 1) Arquivos criados/alterados

**Novo:**
- `tests/commercePhase4Adversarial.test.js` — 14 testes, com dublês mínimos de `guild`/`interaction` do discord.js pra exercitar o handler real (`commerce.handle`) sem precisar de um bot conectado.

**Alterados:**
- `src/handlers/domains/commerce.js`:
  - Novo botão/select **"Ver detalhes"** (`commerce_view_plan_details`) no painel de planos — mostra descrição, preço/período e recursos/limites completos (incluindo armazenamento) de um plano específico; revalida `PUBLISHED` no momento do clique, nunca confia que o menu ainda reflete o catálogo atual.
  - `productSummaryLine`/nova `productDetailDescription` passam a mostrar o período de cobrança (`billing_period`, hoje sempre "mês") e o armazenamento (`storage`) do produto, além de bots/RAM/CPU.
  - **Corrigida corrida de duplo pedido** em `commerce_buy_plan`: lock em memória (`buyClaimLocks`, um `Set` por `userId`), checado e marcado de forma síncrona antes de qualquer `await` — fecha a janela entre dois cliques rápidos que antes podia criar dois canais/pedidos pro mesmo cliente.
  - **Corrigida corrida de duplo comprovante** em `commerce_send_proof`: lock em memória (`activeProofCollectors`, um `Set` por `orderId`) — evita que dois cliques em "Enviar Comprovante" criem dois `MessageCollector` independentes que, por não se excluírem mutuamente, ambos capturariam a MESMA mensagem/anexo e chamariam `ProofManager.submitProof()` duas vezes. Liberado no evento `'end'` do collector (dispara tanto no sucesso quanto no timeout), nunca deixando o pedido travado sem chance de nova tentativa.
- `src/commands/comercial.js`:
  - `/configurar-loja` agora cria um **cargo dedicado do Discord** ("Atlantic Host — Comercial") já na estrutura inicial, aplicado como overwrite de visibilidade na categoria staff — corrige a fricção operacional documentada como risco #1 da Fase 3. Também ganhou um caminho de **reparo**: se a loja já estava configurada mas sem esse cargo (instalações anteriores à Fase 4), o comando cria só o cargo que falta e aplica na categoria staff existente, sem recriar nada.
  - Novo comando **`/comercial-equipe`** (`conceder`/`revogar`, admin-only, com opção de usuário) — concede/revoga `COMMERCE_STAFF` via `CommerceStaffManager` (a fonte real de autorização) **e**, no mesmo passo, atribui/remove o cargo Discord de visibilidade. O código e os comentários deixam explícito que o cargo nunca é checado como autorização em lugar nenhum do sistema — só `CommerceStaffManager.hasCommercePermission()` (linha no banco) decide isso, revalidada dentro de cada manager.

## 2) Revisão de segurança (checklist pedido)

| Item | Situação |
|---|---|
| IDOR entre pedidos | Já defendido desde a Fase 3 (`order.user_id` revalidado em cada handler contra o banco); reafirmado por 2 testes novos de handler (seleção de produto e cancelamento no canal de outro cliente). |
| IDOR em comprovantes | Já defendido (`ProofManager` — dono do pedido + `hasCommercePermission` pra visualizar); sem regressão. |
| Manipular `product_id` | `buildProductSnapshot()` sempre exige `PUBLISHED` — e agora `commerce_view_plan_details` também revalida no clique, mesmo tendo vindo de um menu montado a partir de `getPublishedProducts()`. Testado: produto pausado *depois* do menu montado é recusado; `productId` inexistente/forjado nunca crasha. |
| Manipular preço | `OrderManager.confirmProduct()` não tem parâmetro de preço — preço sempre derivado do produto no banco (invariante já testada na Fase 2, sem alteração nesta fase). |
| Alterar `order_id` | Todos os fluxos do cliente (`commerce_pay`, `commerce_send_proof`, `commerce_select_product`, `commerce_cancel_order`) resolvem o pedido a partir de `interaction.channelId` — o ID do canal real onde o clique ocorreu — nunca de um valor que o cliente possa digitar; o canal em si já é privado por permissão do Discord. Fluxos de staff embutem o `orderId` em `customId`s montados só no servidor, dentro de respostas ephemeral (visíveis só a quem clicou); mesmo assim `hasCommercePermission()` é revalidado em cada handler, então mesmo um `customId` forjado não teria efeito sem permissão comercial real. |
| Agir sobre pedido de outro cliente | Testado (novo): cliente B tentando selecionar produto ou cancelar no canal do cliente A é barrado, e o pedido do cliente A permanece intocado. |
| Staff revogado tentando agir | Testado (novo): staff concedido e depois revogado é barrado já na primeira linha do handler (`commerce_staff_approve_*`, `commerce_staff_queue`), resposta explícita "Acesso negado" — a checagem é sempre contra `commerce_staff.revoked_at IS NULL` no banco, nunca cacheada. |
| Concorrência em compra | Corrigida (ver seção 1) e testada: dois cliques quase simultâneos resultam em exatamente um canal/pedido; o segundo recebe uma resposta explícita, nunca silêncio. |
| Concorrência em envio de comprovante | Corrigida (ver seção 1) e testada: dois cliques quase simultâneos resultam em exatamente um `MessageCollector`; testado também que o lock é liberado corretamente após o fim do collector, permitindo nova tentativa depois. |
| Canais privados configurados incorretamente | Testado (novo): overwrites do canal do pedido negam `@everyone` explicitamente, liberam só o comprador e (quando configurado) o cargo de staff — nunca mais que essas três entradas; testado também o caso sem `staff_role_id` configurado (overwrite nunca referencia um cargo inexistente/`undefined`). |

## 3) Máquina de estados e CAS

Nenhuma mudança na máquina de estados (`OrderManager.VALID_TRANSITIONS`) nem no primitivo de transição (`transitionOrder`, CAS via `UPDATE ... WHERE status IN (...)`). Os novos locks em memória desta fase (`buyClaimLocks`, `activeProofCollectors`) atuam **antes** de qualquer transição de banco — são uma camada adicional na UI, não uma substituição do CAS que já protege `commerce_orders.status` (continua sendo o único lugar que já era, dentro de `OrderManager.js`).

## 4) Testes novos (14)

`tests/commercePhase4Adversarial.test.js`: painel de planos mostra nome/preço/período/recursos; "Ver detalhes" com descrição e armazenamento; revalidação de `PUBLISHED` no clique (produto pausado depois do menu, produto inexistente); corrida de duplo pedido (concorrente e sequencial); overwrites do canal privado (com e sem cargo de staff); corrida de duplo comprovante (concorrente e liberação pós-`end`); staff revogado barrado em dois handlers diferentes; IDOR de seleção de produto e cancelamento entre clientes.

## 5) Resultado da suíte completa

```
tests 377
pass 372
fail 0
cancelled 0
skipped 5
```
0 falhas, 0 regressões (14 testes novos: 363 → 377; os 5 `skipped` são pré-existentes de fases anteriores).

## 6) Invariantes preservadas (confirmado, sem exceção)

- `capacityManager.js` continua a única fonte de escrita de `users.max_bots/max_ram/max_cpu` — nenhum arquivo desta fase toca nessas colunas.
- Entitlement ativo continua com precedência sobre `plan_id` legado — não alterado.
- Nenhum módulo comercial (incluindo os dois arquivos alterados nesta fase) importa `SecurityEngine`, `IncidentResponseManager` ou `SecurityMonitor` — confirmado por leitura direta e pelos testes estruturais já existentes da Fase 2/3, que continuam passando.
- Nenhum fallback inseguro foi introduzido: toda falha (produto indisponível, pedido não encontrado, corrida perdida) resulta numa resposta explícita ao usuário, nunca num estado ambíguo ou numa ação silenciosa.
- Permissões reais continuam 100% dentro dos managers (`hasCommercePermission`, `hasPermission('admin')`) — os novos locks em memória e o cargo Discord são só camadas de UI/visibilidade, nunca decidem autorização.
- Preço/limites/IDs do cliente nunca são confiados — reforçado nesta fase com a revalidação extra em "Ver detalhes".
- `Order.status` continua exclusivamente via CAS em `OrderManager.transitionOrder()`.
- Payment confirmado (`PaymentManager.confirmPayment`) continua levando o pedido só até `APPROVED`, nunca `ACTIVE` — não tocado nesta fase.
- Nenhum provisionamento automático foi implementado — `ProvisioningManager` continua fora de escopo.

## 7) Riscos encontrados

1. **Instalações já configuradas antes da Fase 4** (staff_role_id nulo) precisam rodar `/configurar-loja` novamente pra ganhar o cargo de visibilidade — o comando já trata esse caso (caminho de reparo, sem recriar canais), mas depende de um admin executar o comando manualmente; não há uma migração automática na inicialização do bot. Aceitável para v1 (nenhuma instância em produção ainda), mas vale documentar no runbook operacional.
2. **Locks em memória (`buyClaimLocks`, `activeProofCollectors`) não sobrevivem a um restart do processo.** Se o bot reiniciar exatamente entre o lock ser tomado e a operação terminar, o lock se perde (comportamento aceitável — na pior hipótese, uma corrida rara e de baixíssima probabilidade volta a existir só nesse instante específico de restart, nunca causa dado inconsistente porque o CAS do `OrderManager` continua sendo a garantia de fundo). Não é diferente do padrão de locks em memória já usado em outras partes do sistema (ex.: `IncidentResponseManager`).
3. **`storage` e `billing_period` já existiam no schema desde a Fase 2/3 mas nunca eram mostrados ao cliente** — corrigido nesta fase; produtos criados antes disso continuam com os valores default (`storage: 1024`, `billingPeriod: 'monthly'`) já gravados, nenhuma migração necessária.
4. Nenhum módulo comercial cria/spawna processo — confirmado, sem mudança nesta fase.

## 8) Commit

Aguardando push nesta mensagem — hash reportado a seguir.
