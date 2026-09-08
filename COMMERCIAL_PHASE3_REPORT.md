# Fase 3 — Sistema Comercial: UI Discord + Fonte Única de Capacidade + Comprovantes + Aprovação

Relatório final da Fase 3, autorizada sobre o commit `f0f8130` (Fase 2 validada). Escopo: resolver a fonte única de capacidade (`users.max_bots/max_ram/max_cpu`), implementar a interface comercial 100% dentro do Discord (loja pública + painel staff/admin), envio/validação/armazenamento seguro de comprovantes, e fluxo de aprovação com CAS. **Não implementado nesta fase** (conforme instruído): provisionamento automático de bot, dashboard web, afiliados, estorno automático, aprovação de quatro olhos.

## 1) Arquivos criados/alterados

**Novos:**
- `src/managers/capacityManager.js` — fonte única de `users.max_bots/max_ram/max_cpu`.
- `src/managers/commerce/ProofManager.js` — comprovantes: validação de tipo por conteúdo, armazenamento cifrado, IDOR, auditoria.
- `src/managers/commerce/CommerceConfig.js` — estrutura de canais/categorias da loja (linha singleton).
- `src/commands/comercial.js` — `/configurar-loja`, `/painel-de-vendas`, `/painel-comercial`.
- `src/handlers/domains/commerce.js` — handler de UI (cliente/staff/admin), ~660 linhas.
- Testes: `tests/capacityManager.test.js` (9), `tests/commerceProofManager.test.js` (16), `tests/commercePhase3Adversarial.test.js` (11).

**Alterados:**
- `src/database/database.js` — tabela `commerce_proofs` (+2 índices), tabela `commerce_config` (+linha default), `commerce_products.status` DEFAULT passa de `'active'` para `'draft'`.
- `config.js` — `commerce.proofsFolder`, `commerce.maxProofSizeBytes`.
- `src/managers/commerce/ProductCatalog.js` — reescrito: ciclo de vida `DRAFT → PUBLISHED → PAUSED → ARCHIVED` (era `ACTIVE/ARCHIVED`), `publishProduct`/`pauseProduct`, `getPublishedProducts()` dedicado pra vitrine pública.
- `src/managers/commerce/PaymentManager.js` — `confirmPayment`/`rejectPayment` agora chamam `ProofManager.markLatestProofStatus()`.
- `src/managers/commerce/EntitlementManager.js` — `recomputeUserCapacity()` delega inteiramente a `capacityManager.js` (removida a lógica antiga que escrevia direto em `users`).
- `src/managers/planManager.js` — `activateUserPlan()` (legado) delega a `capacityManager.recomputeUserCapacity()`; removida a cópia própria da lógica de teto de host.
- `src/handlers/domains/index.js` — `commerce` registrado no router de domínios.
- 6 arquivos de teste de fases anteriores ajustados (chamando `ProductCatalog.publishProduct()` explicitamente após `saveProduct()`, já que produtos agora nascem `DRAFT`).

## 2) Arquitetura implementada

### Fonte única de capacidade (decisão da regra #2)
`capacityManager.js` é o **único** módulo autorizado a escrever `users.max_bots/max_ram/max_cpu`. Precedência documentada e testada: **Entitlement ativo (novo sistema) > `plan_id` legado > default (`config.security.*`)**. Tanto `planManager.activateUserPlan()` (legado) quanto `EntitlementManager.recomputeUserCapacity()` (novo) delegam a ele via lazy-require (evita ciclo). Teste estrutural garante por regex que nenhum dos dois escreve `UPDATE users SET ... max_(bots|ram|cpu)` fora de `capacityManager.js`. Teto de host (`HOST_MAX_*`) aplicado uma única vez, no mesmo lugar — nem legado nem novo sistema conseguem excedê-lo. Quando o Entitlement expira, a capacidade volta automaticamente pro `plan_id` legado (nunca fica travada no valor antigo).

### UI Discord
- **Loja pública** (categoria `🛒 LOJA`): `#painel-de-vendas` (embed fixo, só leitura pro público) com botões Comprar/Ver Planos/Suporte; `#duvidas-sobre-planos`. Comprar cria um **canal privado do pedido** (visível só ao comprador + staff), com select de produto, resumo do pedido (snapshot), botão Pagar (mostra Pix snapshotado), botão Enviar Comprovante (coleta anexo via `MessageCollector`, valida e armazena via `ProofManager`), botão Cancelar.
- **Painel staff** (categoria privada `💼 COMERCIAL — STAFF`): `#painel-comercial` (fila de pedidos em análise, aprovar/recusar com motivo obrigatório via modal), `#pedidos-em-analise`, `#comprovantes`, `#logs-de-vendas` — todos alimentados automaticamente pelas ações do painel.
- **Admin**: criar produto (modal), publicar/pausar/arquivar, configurar Pix (modal, nunca loga a chave), estatísticas (contagem por status + faturamento do mês + entitlements ativos), auditoria (últimos 15 eventos `commerce:*`).
- Somente produtos com `status = PUBLISHED` aparecem na vitrine e no select de compra (`getPublishedProducts()`, nunca `getAllProducts()` no caminho do cliente).

### Permissões (defesa em profundidade)
Toda ação sensível é checada **duas vezes**: na UI (`commerce.js`, resposta rápida) e dentro do manager (`hasCommercePermission`/`hasPermission('admin')`) — o manager nunca confia só na UI. `Moderator` **não** herda permissão comercial automaticamente (só `Administrator` ou `COMMERCE_STAFF` ativo). Ações puramente administrativas (CRUD de produto, Pix, estatísticas, auditoria) exigem `Administrator` — não são delegáveis a `COMMERCE_STAFF`.

### Comprovantes
`ProofManager.submitProof()`: valida dono do pedido (IDOR), baixa o anexo (nunca confia na URL temporária do Discord além do download imediato), detecta o tipo real por assinatura de bytes (magic bytes) e cruza contra extensão/MIME declarados — os três precisam bater —, valida tamanho declarado E real, cifra em repouso (AES-256-GCM, `fileCrypto.js`), grava hash sha256 pra detectar corrupção/adulteração. `getDecryptedProof()` só libera pra staff comercial, nunca pro próprio cliente. Toda submissão e visualização é auditada.

## 3) Decisões tomadas sobre `users.max_bots/ram/cpu`

Ver seção 2 ("Fonte única de capacidade"). Resumo executivo: **uma função, uma precedência documentada, dois consumidores (legado e novo) delegando a ela**, nunca duas escritas concorrentes. Validado por 9 testes dedicados (`capacityManager.test.js`) cobrindo cada combinação (só legado, só novo, os dois juntos, expiração revertendo pro legado, teto de host, e regressão explícita de `activateUserPlan`).

## 4) Testes novos (36 no total desta fase)

- `capacityManager.test.js` (9): precedência, teto de host, ausência de fonte dupla, regressão do legado.
- `commerceProofManager.test.js` (16): upload válido, IDOR, tipo real por conteúdo (3 variantes), tamanho declarado vs. real, histórico nunca sobrescreve, permissão de visualização, auditoria, isolamento entre pedidos, integridade (arquivo adulterado falha explicitamente).
- `commercePhase3Adversarial.test.js` (11): `CommerceConfig` (getConfig/isConfigured/saveChannelStructure com merge), integração `PaymentManager → ProofManager.markLatestProofStatus`, dupla aprovação através do ponto de entrada real da UI (`PaymentManager.confirmPayment`, incluindo aprovar-vs-recusar simultâneo), isolamento fim-a-fim entre dois clientes rodando o pipeline completo (compra → comprovante → aprovação → entitlement) em paralelo, cancelamento não afeta terceiros, revalidação de permissão nos managers.

Mais os ajustes de 6 arquivos de teste pré-existentes pra continuar publicando produtos explicitamente (mudança de comportamento sancionada: produtos agora nascem `DRAFT`).

## 5) Resultado da suíte completa

```
tests 363
pass 358
fail 0
cancelled 0
skipped 5
```
0 falhas, 0 regressões. (Os 5 `skipped` são pré-existentes de fases anteriores, não relacionados a esta entrega.)

## 6) Riscos encontrados

1. **Visibilidade de canal vs. permissão real**: a categoria staff nega `@everyone` por padrão, mas um `COMMERCE_STAFF` sem cargo Discord atribuído (`staff_role_id` fica `null` até um admin configurar isso manualmente) não enxerga os canais staff mesmo tendo permissão real nos managers. Não é uma falha de segurança (a checagem interna sempre vale), mas é uma fricção operacional — documentado no comentário do `comercial.js`. Mitigação futura: o admin pode configurar `staff_role_id` depois pelo painel (ainda não construído — hoje só via banco).
2. **Dependência do `MessageCollector` de 5 minutos** pro fluxo de envio de comprovante: se o cliente enviar o arquivo depois da janela, o comprovante não é capturado e o cliente não recebe um aviso automático de expiração — precisa clicar "Enviar Comprovante" de novo. Comportamento aceitável pra v1, mas vale nota.
3. **`commerce_admin_stats`** faz `COUNT(*)` por status a cada clique sem cache — não é um risco de segurança, só uma nota de performance caso o volume de pedidos cresça muito (sem índice composto em `status` além do já existente).
4. Prefixos mortos que existiam num rascunho anterior (`commerce_admin_edit_product_*`) foram removidos nesta revisão antes do commit — não há mais nenhum `customId` declarado no roteador sem handler correspondente.
5. Nenhum módulo comercial importa `SecurityEngine`/`IncidentResponseManager`/`SecurityMonitor`/`processManager`/`child_process` (confirmado por teste estrutural já existente da Fase 2, revalidado nesta suíte). Nenhuma alteração em sandbox/Kamikaze/readiness foi necessária ou feita.

## 7) Commit

Aguardando push nesta mensagem — hash reportado a seguir.
