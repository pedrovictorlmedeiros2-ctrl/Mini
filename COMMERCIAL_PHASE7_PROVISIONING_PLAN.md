# Fase 7 — Plano de Arquitetura: ProvisioningManager

Documento de arquitetura (SEM implementação) para revisão e aprovação antes de qualquer código ser escrito, conforme pedido explicitamente: "NÃO implemente imediatamente após o plano." Autorizada sobre o commit `06756f9` (Fase 6 validada).

---

## 1. Revisão da arquitetura atual (confirmada por leitura direta do código, não por suposição)

| Peça | Estado hoje | Fonte |
|---|---|---|
| `serviceReadiness.js` | 3 estados (`READY`/`DEGRADED`/`BLOCKED`), default de boot é `BLOCKED` (fail-closed). `assertProvisioningAllowed()` só lança em `BLOCKED` — `DEGRADED` nunca bloqueia nada hoje. Único chamador atual: `processManager.startBot()`. **Nenhum arquivo em `src/managers/commerce/` referencia isto ainda.** | `src/managers/serviceReadiness.js` |
| `capacityManager.js` | Única escrita confirmada em `users.max_bots/max_ram/max_cpu` (grep: 1 único hit). Precedência: Entitlement ativo > `plan_id` legado > default. | `src/managers/capacityManager.js:56` |
| Kamikaze/incidentes | `bots.suspended`/`suspended_reason` são **por bot**, nunca por usuário/tenant. `incidents.bot_id` tem FK pra `bots`, sem `user_id`. **Não existe nenhuma coluna de suspensão em `users`.** | `database.js` (schema `bots`/`incidents`), `IncidentResponseManager.js` |
| `processManager.startBot()` / `SandboxManager` | Zero referências a `Order`/`commerce` em qualquer um dos dois arquivos (grep confirmado). Backend de sandbox é só seletor de isolamento, sem lógica de capacidade/suspensão própria — quem checa `bots.suspended` é `startBot()`, antes de decidir o backend. | `processManager.js`, `sandbox/SandboxManager.js` |
| `EntitlementManager.grant()` | Idempotente (no-op se já existe entitlement ativo pro `orderId`); exige `order.status === PROVISIONING`; já chama `capacityManager.recomputeUserCapacity()` internamente (não é uma etapa separada). `commerce_entitlements.order_id` tem `UNIQUE` no schema — segunda camada de garantia persistente contra duplicação, independente do código. **Confirmado por grep: `grant()` não é chamado por NENHUM código de produção hoje — só por testes.** Ou seja, não existe nenhum caminho alternativo de provisionamento a desativar; a Fase 7 cria o PRIMEIRO chamador real. | `EntitlementManager.js`, `database.js:403` |
| `OrderManager` — máquina de estados | Sem mudança necessária: `APPROVED → PROVISIONING → {ACTIVE, PROVISIONING_FAILED}`, `PROVISIONING_FAILED → PROVISIONING` (retry permitido). `PROVISIONING_FAILED` não é terminal. `transitionOrder()` continua o único primitivo de escrita de `status`. | `OrderManager.js` |
| `commerce_provisioning_attempts` | **Não existe.** Só citada em `COMMERCIAL_ARCHITECTURE_PROPOSAL.md` como sketch de design (não implementado). | grep confirmado |
| `CommerceScheduler.reconcileStuckProvisioning()` | Já escrita (Fase 2), mas **não está ligada a nenhum timer/sweep periódico hoje** (não está em `runAllSweeps()`) — código morto do ponto de vista de agendamento, só chamável manualmente/por teste. Comportamento atual: flipa **incondicionalmente** todo pedido em `PROVISIONING` pra `PROVISIONING_FAILED`. | `CommerceScheduler.js:85-103` |
| Boot (`index.js`) | Padrão já estabelecido: `reconcileStuckIncidents().catch(...)` roda uma vez no boot, assíncrono, não-bloqueante — mesmo espírito que `reconcileStuckProvisioning()` precisa seguir. | `index.js:117-119` |
| `queueManager.js` | Fila de prioridade genérica já existente (`addToQueue(taskFn, description, {priority, timeoutMs})`, retorna Promise) — infraestrutura pronta pra enfileirar o provisionamento fora do ciclo de vida da interação do Discord. | `src/managers/queueManager.js` |

**Conclusão da revisão:** a arquitetura de Fases 1-6 já foi construída deliberadamente para este momento — `Order.status=PROVISIONING` existe e nunca é alcançado por nenhum código hoje; `EntitlementManager.grant()` existe, é idempotente, mas nunca é chamado; `capacityManager` já é a fonte única de capacidade; `serviceReadiness` já existe e só falta ser conectado ao fluxo comercial. **Não há nenhum caminho alternativo de provisionamento pra desmontar — o trabalho da Fase 7 é inteiramente aditivo.**

---

## 2. Novo módulo: `src/managers/commerce/ProvisioningManager.js`

Único ponto de autoridade comercial pra provisionamento (regra absoluta #1). Depende de: `OrderManager` (CAS), `PaymentManager` (leitura, nunca escrita), `EntitlementManager` (concessão idempotente), `serviceReadiness` (`assertProvisioningAllowed`), `CommerceStaffManager` (permissão em retry manual), `queueManager` (execução fora da interação), `auditManager`. **Nunca** importa `child_process`, `SandboxManager`, `processManager`, ou qualquer coisa de `src/managers/security/`.

### API pública

```js
provision(orderId, { executorUserId = null } = {})
```
- `executorUserId = null` → chamada automática (pós-aprovação, enfileirada pelo próprio sistema). **Nunca depende de permissão Discord do cliente** (regra #14) — o gatilho é a aprovação do staff, já autenticada por `PaymentManager.confirmPayment()`.
- `executorUserId = <id>` → retry manual. Exige `CommerceStaffManager.hasCommercePermission(executorUserId)` (admin ou COMMERCE_STAFF ativo), checado **dentro** deste manager, nunca só na UI.

Retorno: `{ order, entitlement, alreadyActive?: true }` em sucesso; lança `Error` em qualquer falha (o chamador decide o que fazer — enfileirar não-bloqueante ou UI síncrona).

### Fluxo obrigatório (ordem exata pedida)

```
1. Order válido
   → OrderManager.getOrder(orderId); se não existe, lança.

2. Verificar idempotência
   → status === ACTIVE  → retorna sucesso idempotente (no-op, NUNCA reprocessa)
   → status ∉ {APPROVED, PROVISIONING_FAILED, ACTIVE} → lança
     ("pedido não está pronto para provisionamento: <status>")
     (cobre CANCELLED/REJECTED/EXPIRED/DRAFT/etc. — nunca provisionáveis)

3. Verificar Payment confirmado
   → PaymentManager.getPaymentByOrder(orderId).status === 'confirmed'
   → senão, lança (defesa em profundidade — não deveria ser alcançável
     estruturalmente, já que Order só chega em APPROVED/PROVISIONING_FAILED
     com o Payment já confirmado pela Fase 6, mas revalidado aqui mesmo assim,
     mesmo padrão de assertCanReview() da Fase 6)

   ── daqui pra frente, GATE DE EXCLUSIVIDADE (CAS) ──

4. transitionOrder(orderId, [APPROVED, PROVISIONING_FAILED], PROVISIONING)
   → null (corrida perdida / estado mudou) → lança
     ("outro processo já está provisionando este pedido, ou o estado mudou
     — tente novamente")
   → Esta é A garantia persistente de exclusividade mútua (regra #6) — não
     um lock em memória. Cobre: duas aprovações, dois retries, dois
     processos, retry durante restart, retry durante outro provisioning
     já em andamento.

5. INSERT commerce_provisioning_attempts (status='running', order_id,
   entitlement_id=NULL, executor_user_id=executorUserId,
   idempotency_key=`${orderId}:${Date.now()}`, started_at=now)

6. Verificar Entitlement / assertProvisioningAllowed()
   → serviceReadiness.assertProvisioningAllowed('provisionamento comercial:
     pedido #<id>') — lança em BLOCKED (ver seção 4). Em DEGRADED, PROSSEGUE
     (ver seção 5 — decisão explícita, não omissão).

7. Aplicar/conceder capacidade via CapacityManager
   → EntitlementManager.grant(orderId) — já idempotente (no-op se já
     existir um entitlement ativo pra este orderId — cobre "erro depois de
     conceder capacidade" num retry: não duplica); já chama
     capacityManager.recomputeUserCapacity() internamente. ESTE MANAGER
     NUNCA escreve em users.max_bots/ram/cpu diretamente — delega 100%.

8. Verificar resultado real (nunca confiar em retorno booleano)
   → Re-lê o entitlement do banco (getEntitlement(id)) — confirma
     status==='active', order_id === orderId.
   → Re-lê users.max_bots/max_ram/max_cpu do usuário — confirma que
     batem exatamente com order.product_snapshot (maxBots/maxRam/maxCpu).
   → Confirma getActiveEntitlement(order.user_id).id === entitlement.id
     (nunca duas ativas — reforça a invariante já garantida por
     EntitlementManager, mas verificada aqui como o "resultado real",
     não assumida).
   → Qualquer divergência → lança (nunca prossegue pra ACTIVE com um
     estado que não foi de fato confirmado).

9. transitionOrder(orderId, [PROVISIONING], ACTIVE)
   → CAS final. Se null (não deveria acontecer — só este manager, dentro
     desta função síncrona sem await entre o passo 4 e aqui, transiciona
     PROVISIONING → algo), trata como inconsistência: audita como erro,
     NÃO tenta reverter (ver regra #16), lança.

10. Registra provisioning_attempt como 'succeeded' (finished_at=now,
    entitlement_id preenchido), audita commerce:provisioning_succeeded.

11. CATCH (qualquer exceção entre os passos 6-9):
    → Se order ainda está em PROVISIONING: transitionOrder(orderId,
      [PROVISIONING], PROVISIONING_FAILED).
    → Registra provisioning_attempt como 'failed' (finished_at=now,
      error_message=<sanitizado>).
    → Audita commerce:provisioning_failed (severity: 'error').
    → Payment NUNCA é tocado — continua 'confirmed' (regra #8).
    → Relança o erro pro chamador.
```

**Por que a ordem "idempotência → Payment → Entitlement → assertProvisioningAllowed → aplicar → verificar → registrar → ACTIVE" funciona sem precisar de uma segunda estrutura de lock**: o CAS do passo 4 já é o único ponto de exclusividade mútua necessário — tudo que vem depois dele (passos 5-10) roda dentro da "seção crítica" que só um chamador por vez consegue entrar, garantido pelo banco (`UPDATE ... WHERE status IN (...)`), não por memória. A idempotência de `EntitlementManager.grant()` (passo 7) é a segunda camada, cobrindo o caso em que o processo morre DEPOIS do passo 4 mas ANTES do passo 9 — um retry re-entra pelo CAS (agora a partir de `PROVISIONING_FAILED`, depois da reconciliação de boot) e o `grant()` idempotente evita duplicar a concessão.

---

## 3. Novo dado: `commerce_provisioning_attempts`

```sql
CREATE TABLE IF NOT EXISTS commerce_provisioning_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    entitlement_id INTEGER,              -- preenchido só em caso de sucesso
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',   -- running | succeeded | failed
    error_message TEXT,                  -- SEMPRE sanitizado (ver seção 8), nunca cru
    executor_user_id TEXT,               -- NULL = automático pós-aprovação; preenchido = retry manual
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    FOREIGN KEY (order_id) REFERENCES commerce_orders(id),
    FOREIGN KEY (entitlement_id) REFERENCES commerce_entitlements(id),
    FOREIGN KEY (executor_user_id) REFERENCES users(id)
)
```
Índice: `idx_commerce_provisioning_attempts_order ON commerce_provisioning_attempts(order_id)`.

**Esta tabela é um LOG/auditoria, não o mecanismo de exclusão mútua** — a exclusividade real é o CAS do `OrderManager` (passo 4 acima). Cada tentativa (inclusive retries) grava sua própria linha — o histórico completo de tentativas por pedido fica visível pro staff (mesmo espírito do histórico de comprovantes da Fase 6).

---

## 4. Comportamento em `BLOCKED`

Sem ambiguidade, já implementado por `assertProvisioningAllowed()` — reafirmado aqui, não reimplementado:
- **Não provisiona** — a exceção interrompe o fluxo no passo 6, antes de qualquer concessão de capacidade.
- **Não inicia bot** — nunca chegaria perto disso de qualquer forma (v1 nunca cria processo).
- **Não marca ACTIVE** — cai direto no `catch` do passo 11.
- **Motivo registrado** — `state.blockedReasons` (já vem formatado pela própria `serviceReadiness`) vira o `error_message` sanitizado da tentativa.
- **Estado recuperável** — `Order` vai pra `PROVISIONING_FAILED` (não fica preso em `PROVISIONING`), `Payment` continua `confirmed`, retry permitido depois.

---

## 5. Comportamento em `DEGRADED` (decisão explícita, não presumida)

Reli os três motivos de `DEGRADED` hoje: `LOG_WEBHOOK_URL` ausente, Docker indisponível (só relevante pra bots com backend de container), Groq degradado (analisador auxiliar do SecurityMonitor). **Nenhum dos três tem qualquer relação com a operação que a v1 do `ProvisioningManager` executa** — que é exclusivamente `EntitlementManager.grant()` (uma escrita de banco + recomputo de capacidade), sem tocar em webhook, Docker ou Groq.

**Decisão: `DEGRADED` NÃO bloqueia provisionamento nesta fase — mas isso é registrado, não silenciado.** `assertProvisioningAllowed()` já não lança em `DEGRADED` (comportamento existente, correto pra este caso). O `ProvisioningManager` adicionalmente:
- Lê `serviceReadiness.getReadinessState()` no passo 6 e, se `status === 'DEGRADED'`, inclui `degradedReasons` nos detalhes do `provisioning_attempt` e do evento de auditoria (`commerce:provisioning_degraded_context`, severidade `info`) — visibilidade total, nunca um "sucesso silencioso" que esconde que o host estava degradado no momento.

**Isto NÃO é uma regra permanente — é uma decisão de escopo da v1 (`entitlement_only`).** Documentado aqui explicitamente pra quando uma fase futura implementar uma estratégia que de fato toque em sandbox/processo/container: nesse momento, `DEGRADED` por Docker indisponível PASSARIA a importar (um backend de container não consegue subir), e a checagem precisaria ser por-estratégia, não genérica. **Isto é fora do escopo desta fase** (regra #18 — nenhuma criação automática de bot) — deixado como ponto de extensão explícito, não implementado agora.

---

## 6. Kamikaze / suspensão — precedência (por que a separação estrutural já garante isso)

A regra #13 pede que Kamikaze tenha precedência sobre provisionamento comercial e que um tenant suspenso nunca seja reativado silenciosamente. Investigação confirmou: `bots.suspended` é **por bot**, não existe suspensão por usuário/tenant, e `processManager.startBot()` (que É quem checa `bots.suspended`) já recusa iniciar um bot suspenso, **hoje, independente de qualquer coisa comercial**.

**Decisão: `ProvisioningManager` v1 nunca chama `processManager.startBot()`, nunca lê nem escreve `bots.suspended`, nunca importa `SandboxManager`.** Como a única operação da v1 é aplicar um NÚMERO (capacidade máxima) à conta do usuário — nunca iniciar/reiniciar um processo — não existe fisicamente nenhum caminho de código pelo qual conceder capacidade poderia "reativar" um bot suspenso: reativar exigiria chamar `startBot()`, e isso é proibido pela regra #2 desta fase. A precedência do Kamikaze é garantida pela **ausência estrutural** desse caminho, não por uma checagem redundante que duplicaria lógica de segurança dentro do código comercial (o que a regra #12 pede pra evitar). Validado por teste estrutural (grep) na seção 9.

Se uma fase futura algum dia precisar reiniciar/criar um processo como parte do provisionamento, a checagem de `bots.suspended`/estado de incidente ativo teria que ser adicionada **ali**, no momento de decidir iniciar o processo (mesmo lugar que já faz isso hoje) — nunca duplicada dentro do `ProvisioningManager`.

---

## 7. Renovação

Sem mudança de comportamento — `EntitlementManager.grant()` já implementa `activated_at = max(agora, expires_at do entitlement anterior)` e fecha o entitlement anterior na mesma operação síncrona (sem `await` no meio, sem janela de corrida). `ProvisioningManager` apenas chama `grant(orderId)` — o `orderId` de uma renovação já carrega `renewal_of_entitlement_id` desde `OrderManager.confirmProduct()` (Fase 2), então nenhuma lógica nova é necessária aqui. Reafirmado, não reimplementado.

---

## 8. Sanitização de erro (nunca secrets)

Função local e autocontida dentro de `ProvisioningManager.js` (não importa nada de `src/managers/security/` — mantém a árvore de dependências limpa, regra já estabelecida desde a Fase 1): trunca a mensagem, remove qualquer coisa que pareça token/chave (mesmo padrão simples já usado em outros pontos do sistema — nunca o objeto de erro bruto, sempre `err.message` truncado e filtrado). Nunca grava stack trace completo no banco (fica só no `console.error` do processo, como já é costume no resto do código).

---

## 9. Validação estrutural (grep/testes) — SEM caminho alternativo

Antes de considerar a Fase 7 pronta, os seguintes greps/testes estruturais precisam passar (planejados aqui, escritos na fase de implementação):

1. `grep -rn "EntitlementManager.grant(" src/` → só `ProvisioningManager.js` (fora de `tests/`).
2. `grep -rn "require.*child_process\|SandboxManager\|processManager" src/managers/commerce/` → zero ocorrências, incluindo o novo arquivo.
3. `grep -rn "UPDATE\s\+users\s\+SET" src/managers/commerce/ProvisioningManager.js` → zero (nunca escreve capacidade direto).
4. `grep -rn "UPDATE\s\+commerce_orders\s\+SET\s\+status" src/managers/commerce/` → só dentro de `OrderManager.js` (nenhuma mudança nesta invariante já validada desde a Fase 2).
5. Teste estrutural: `ProvisioningManager.js` nunca importa nada de `src/managers/security/`.
6. Teste estrutural: toda função pública sensível (`provision`) valida `assertCanReview`-equivalente (permissão) quando `executorUserId` é fornecido.
7. Diagrama de dependência (documentado, verificado por leitura): `commerce.js (UI) → PaymentManager/ProvisioningManager → OrderManager (CAS) + EntitlementManager (idempotente) + serviceReadiness (gate) + capacityManager (via EntitlementManager)` — uma árvore, nunca um grafo com ciclos ou atalhos.

---

## 10. Wiring (planejado, não implementado nesta etapa)

- `src/handlers/domains/commerce.js`, dentro de `commerce_staff_approve_`: após `PaymentManager.confirmPayment()` suceder, `queueManager.addToQueue(() => ProvisioningManager.provision(order.id), ...)` — não bloqueia a resposta da interação; o resultado (sucesso ou falha) dispara uma notificação separada ao comprador/canal de log quando a Promise resolver/rejeitar. `ProvisioningManager` permanece 100% agnóstico de Discord (nunca importa `discord.js`, nunca recebe `interaction`) — a notificação é responsabilidade da UI, mesmo padrão já usado em todo o resto do arquivo.
- Novo botão/handler (staff, permissão via `CommerceStaffManager.hasCommercePermission`) pra retry manual em pedidos `PROVISIONING_FAILED` — chama `ProvisioningManager.provision(orderId, { executorUserId: staffId })`.
- `index.js`: adicionar `CommerceScheduler.reconcileStuckProvisioning()` uma vez no boot, mesmo padrão exato de `reconcileStuckIncidents()` (linha 117-119 hoje) — assíncrono, não-bloqueante, log em caso de falha. **Nunca chamado periodicamente** enquanto o `ProvisioningManager` está rodando (evitaria uma corrida real entre a varredura e uma tentativa genuinamente em andamento — risco identificado na revisão da seção 1).

---

## 11. Testes planejados (não escritos ainda — lista de cobertura)

Idempotência/concorrência (regra #15, lista completa): duas aprovações simultâneas, dois retries simultâneos, retry durante restart (simulado via reconciliação de boot), retry durante `BLOCKED`, retry durante `DEGRADED` (deve suceder, com o contexto degradado auditado), dois processos "provisionando" o mesmo order (via CAS, um só vence), erro depois de conceder capacidade (grant já idempotente cobre — testar retry subsequente não duplica), erro antes de conceder capacidade (nenhum entitlement deveria existir), payment confirmado + entitlement ausente (fluxo normal, `grant()` cria), entitlement duplicado (forçado via SQL — `getActiveEntitlement` já lança `EntitlementConflictError`, `ProvisioningManager` precisa tratar isso na verificação real do passo 8), order já `ACTIVE` (idempotente, no-op), order `PROVISIONING_FAILED` (retry funciona), order `CANCELLED`/`EXPIRED` (nunca provisiona), staff revogado tentando retry (nega, mesmo padrão da Fase 6). Mais: verificação real pós-operação nunca confia em retorno `true`; sanitização de erro nunca vaza segredo; auditoria completa; reconciliação de boot nunca compete com uma tentativa genuinamente em andamento (teste específico pra este risco).

---

## 12. Fora de escopo (reafirmado, regra #18)

Site, login, mini VS Code, Atlantic AI, afiliados, refund/chargeback automático, criação automática de bot pelo plano — a v1 continua vendendo **capacidade**, nunca criando um bot sozinha. `ProvisioningManager` v1 é estritamente a estratégia `entitlement_only` já prevista desde a Fase 1.

---

## 13. Riscos e decisões abertas para validação do usuário antes de eu implementar

1. **Notificação ao comprador em caso de falha de provisionamento**: proponho DM + post no canal de log (`sales_log_channel_id`), texto claro de que o pagamento continua confirmado e a equipe já foi notificada — sem pedir pro cliente pagar de novo. Confirmar que esse é o tom esperado.
2. **UI de retry manual**: proponho uma nova listagem "Falhas de Provisionamento" no painel staff (mesmo padrão de `commerce_staff_queue`), já que hoje não existe nenhum lugar que mostre pedidos em `PROVISIONING_FAILED`. Confirmar se isso deve entrar nesta fase ou ficar pra depois (a regra #14 exige que o RETRY exista e seja protegido por permissão — não necessariamente que exista uma listagem dedicada; um comando/botão avulso também atenderia).
3. **Auditoria de contexto `DEGRADED`**: confirmar que registrar (não bloquear) é o comportamento esperado, dado que nenhum motivo de `DEGRADED` hoje afeta a operação real da v1.

---

# Análise da falha isolada da Fase 6 (pedido explícito antes de finalizar a Fase 7)

Executei a suíte completa **43 vezes adicionais** desde o relatório da Fase 6 (18 corridas simples, 15 focadas só nos arquivos `commerce*`, 10 com `npm test` puro), todas limpas (0 falhas). Uma corrida adicional com `--test-concurrency=16` forçado (o quádruplo do paralelismo padrão desta máquina de 4 vCPUs) está em andamento em background no momento em que escrevo isto — resultado será incluído no relatório final da Fase 7.

**Não foi possível reproduzir a falha original em nenhuma das 43 tentativas.** Análise de causa provável, por eliminação:
- Nenhum teste novo das Fases 5/6 depende de temporizador real (`setTimeout` não-mockado) — os testes de concorrência usam `Promise.all`/promises controladas manualmente (`resolveFetch`), que são determinísticos dentro de um mesmo processo Node, sem dependência de relógio de parede além de comparações de data com offset fixo (`datetime('now', '-N days')`).
- `node --test` sem lista explícita de arquivos executa **cada arquivo de teste como um processo separado** (isolamento padrão do test runner do Node desde a v20) — ou seja, dezenas de processos Node concorrentes, cada um criando/apagando seu próprio arquivo SQLite e diretório temporário. A hipótese mais provável é contenção transitória de I/O de disco (não de lógica) sob a carga combinada de todos os arquivos de teste do repositório rodando ao mesmo tempo — não reproduzida mesmo forçando mais paralelismo, o que enfraquece mas não elimina essa hipótese.
- Conclusão: tratada como **flaky ambiental, não uma falha de lógica** — nenhuma evidência de um padrão de corrida real nos testes desta sessão depois de 43 tentativas adicionais. Se a falha reaparecer no futuro com um teste identificável, deve ser tratada como um achado real, não descartada por padrão.

---

**Este documento é só o plano.** Aguardando aprovação explícita antes de criar/alterar qualquer arquivo de implementação, conforme instruído.
