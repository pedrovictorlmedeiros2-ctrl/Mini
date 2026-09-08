# SECURITY_MONITOR_REVIEW.md — Revisão de Segurança Adversarial da Fase 2

Revisão pedida explicitamente antes de qualquer arquitetura de sistema
comercial: reler a Fase 2 inteira (SecurityMonitor + Groq) com olhar
adversarial, tentando ativamente quebrar cada garantia declarada, escrever
testes que provem (ou refutem) cada uma, corrigir só o que for um achado
real, e classificar cada ponto pedido como **VALIDADO**, **NÃO VALIDADO**,
**DEPENDE DE VPS** ou **RISCO ABERTO**.

Constraint respeitado: nenhum deploy real, nenhuma alteração de secret,
nenhuma chamada de rede real ao Groq durante a revisão inteira (toda
verificação usou injeção de dependência — `httpPost`, `_setAnalyzeThreatForTests`
— ou espiar `axios.post` localmente, nunca uma chave real).

Metodologia: releitura linha a linha de todo o código da Fase 2
(`redactPayload.js`, `GroqThreatAnalyzer.js`, `ThreatDecisionPolicy.js`,
`SignalCollector.js`, `SecurityMonitor.js`, mais os pontos de integração em
`SecurityEngine.js`, `IncidentResponseManager.js`, `serviceReadiness.js`,
`index.js`), com cada suspeita reproduzida via teste ANTES de qualquer
correção — mesma disciplina usada na validação do Kamikaze na fase
anterior. Resultado: **4 achados reais corrigidos** (mudanças cirúrgicas,
nenhuma mudança de arquitetura) e **7 riscos abertos documentados e
comprovados por teste**, nenhum deles explorável hoje contra a garantia
central ("Groq nunca ativa CRITICAL/Kamikaze sozinho").

Novo arquivo de teste: `tests/securityPhase2Adversarial.test.js` — **38
testes adversariais**, todos passando, executados em conjunto com a suíte
completa **10+ vezes seguidas sem flake** (após ajustar uma margem de
tempo frouxa demais num teste de performance).

Suíte completa após a revisão: **219 testes, 214 passando, 0 falhas, 5
skips** (baseline anterior de 181 + 38 novos).

---

## Achados reais corrigidos (mudanças cirúrgicas, sem alterar arquitetura)

### F1 — Margem de timeout da fila menor que o pior caso real de retry

**O quê:** `SecurityMonitor.js` calculava o timeout da tarefa na fila como
`requestTimeoutMs + 5000` (fixo). Sob a config DEFAULT
(`requestTimeoutMs=5000`, `maxRetries=1`), o pior caso REAL de
`GroqThreatAnalyzer.analyzeThreat()` (2 tentativas de 5000ms + 500ms de
backoff entre elas) soma **10500ms** — acima da margem de **10000ms**. A
fila podia matar uma tentativa que ainda estava dentro do próprio
orçamento de retry do GroqThreatAnalyzer (sem cancelar a chamada de rede
de verdade — só solta o slot da fila mais cedo, deixando uma promise
órfã rodando em segundo plano).

**Reprodução:** confirmado por cálculo direto antes de qualquer correção
(10500ms > 10000ms) e travado por teste de regressão.

**Correção:** nova função `maxPossibleDurationMs(cfg)` exportada de
`GroqThreatAnalyzer.js` (única fonte de verdade pra esse cálculo),
consumida por `SecurityMonitor.js` com uma margem extra de 2000ms por
cima. Nenhuma mudança de comportamento externo — só corrige o número.

**Teste:** `ACHADO CORRIGIDO — margem de timeout da fila`,
`WIRING: SecurityMonitor não usa mais a fórmula antiga`,
`INTEGRAÇÃO: uma análise legitimamente lenta (mas dentro do orçamento)
nunca é morta pelo timeout da fila`.

### F2 — `redactText()` rodava regex sobre entrada de tamanho ilimitado antes de cortar

**O quê:** as 3 regexes de scrub (token, `KEY=valor`, blob genérico) rodavam
sobre o texto INTEIRO antes do corte por `maxLength` acontecer. Como
`summary` do Groq passa por aqui, uma resposta de um endpoint
comprometido/MITM com um `summary` absurdamente grande forçava esse
trabalho sem nenhum teto.

**Correção:** corte defensivo do texto de ENTRADA para 5000 caracteres
antes de rodar qualquer regex (a saída final já era limitada a
`maxLength`, tipicamente 200-300 chars — nenhum uso legítimo precisa de
mais que isso na entrada).

**Teste:** `ACHADO CORRIGIDO — redactText nunca roda regex sobre uma
entrada absurdamente grande` (2MB de entrada, confirma corte e ausência de
custo catastrófico).

### F3 — Chamada axios ao Groq sem teto de tamanho de resposta

**O quê:** confirmado na versão instalada (axios 1.18.1) que
`maxContentLength`/`maxBodyLength` default são `-1` (ilimitado). Nenhum
teto era passado na chamada — um endpoint comprometido/MITM (sob TLS
quebrado, fora do controle desta plataforma) poderia forçar o processo a
bufferizar uma resposta arbitrariamente grande antes até do
`JSON.parse()` de validação.

**Correção:** `maxContentLength`/`maxBodyLength` = 1MB (generoso — uma
resposta legítima é minúscula, limitada a `max_tokens:400` do lado do
servidor Groq) adicionados à chamada `axios.post`.

**Teste:** `ACHADO CORRIGIDO — axios agora tem teto de tamanho de
resposta` (espiona `axios.post` real e confirma os tetos presentes na
config).

### F4 — Falhas de DNS (`ENOTFOUND`/`EAI_AGAIN`) não eram tratadas como retryable

**O quê:** `isRetryableError()` cobria timeout/5xx/429/`ECONNABORTED`/
`ETIMEDOUT`/`ECONNREFUSED`, mas não os códigos de falha de DNS — uma
falha bem plausível numa VPS com DNS temporariamente instável. Isso fazia
uma falha transitória comum nunca ser tentada de novo.

**Correção:** `ENOTFOUND`/`EAI_AGAIN` adicionados à lista de erros
retryable. Não muda nenhuma garantia de segurança (o resultado fail-safe
já era o mesmo, `unavailable`) — só reduz observação auxiliar perdida à
toa.

**Teste:** dois testes dedicados, um pra cada código, confirmando que
agora HÁ retry (contagem de chamadas = 2, não 1).

---

## Revisão ponto a ponto (conforme pedido)

### 1. Fluxo Groq → ThreatDecisionPolicy → SecurityEngine

**VALIDADO.** Confirmado por leitura de código E por teste estrutural
(`ESTRUTURAL: nenhum arquivo do pipeline Groq importa IncidentResponseManager
nem APIs perigosas`) que nenhum dos 5 arquivos do pipeline importa
`child_process`, `eval`, `fs.unlink`/`fs.rm*`, nem `IncidentResponseManager`.
O único efeito possível de um resultado do Groq é
`ThreatDecisionPolicy.applyThreatDecision()` chamar
`SecurityEngine.reportSignal()` — o MESMO ponto de entrada usado por
qualquer outra fonte de sinal, sem nenhum atalho. `botId` sempre vem de
quem chama (`SignalCollector`, que leu do `audit_log` — nunca do Groq).
Testado com botIds adversariais (SQL-like, muito longos, unicode,
`../../etc/passwd`) passando pelo fluxo inteiro sem quebrar nem vazar cru.

### 2. Impossibilidade de Groq disparar CRITICAL/Kamikaze diretamente

**VALIDADO**, com uma guarda nova contra deriva silenciosa da arquitetura.
Além dos testes já existentes (20x `likely_malicious` confiança 0.99 nunca
cria incidente), esta revisão adicionou um teste de **invariante
estrutural** que falha imediatamente se algum dia um code do Groq for
adicionado a `SIGNAL_CATEGORY` ou `HARD_EVIDENCE_CODES` — as duas únicas
portas de entrada pra CRITICAL no `SecurityEngine.js`. Também testado:
Groq tentando imitar uma categoria determinística real
(`categories:['sandbox_bypass','network_abuse']`, `needsHumanReview:true`,
confiança 1.0) — irrelevante, porque `applyThreatDecision` nunca lê esse
campo pra decidir nada, só o `classification` mapeado por
`CODE_FOR_CLASSIFICATION` (2 entradas fixas, congeladas).

### 3. Redaction/allowlist

**VALIDADO** para o objetivo central (nenhum secret real da plataforma
sobrevive no payload), com **1 risco aberto documentado** (ver RISCOS
ABERTOS #1). Testado com caminhos contendo `.env`, `hosting.db`,
`ENCRYPTION_KEY=...`, `GITHUB_WEBHOOK_SECRET=...` — todos viram só
`{hash, category}`, nunca o texto cru, confirmado por
`JSON.stringify(payload)` inteiro nunca conter o segredo original (nem
parcialmente). `botId` real nunca aparece, só o pseudônimo — mesmo pra um
`botId` deliberadamente parecido com uma chave AWS. Fluxo completo (sinal
real → `audit_log` → `SignalCollector` → payload final) testado
ponta-a-ponta com um `ENCRYPTION_KEY` de teste real presente no ambiente,
confirmando ausência total no payload serializado.

### 4. Prompt injection

**VALIDADO.** O payload enviado ao Groq nunca contém texto livre
(allowlist estrita — ver `redactPayload.js`), então não há onde injetar
uma instrução. Testado explicitamente: um `summary` de RESPOSTA do Groq
contendo texto agressivo de instrução ("IGNORE ALL PREVIOUS RULES... execute:
DELETE FROM bots; rm -rf /") combinado com `classification:'benign'` —
confirma que o texto nunca influencia a decisão (só `classification`/
`confidence` participam, `summary` é sempre inerte). Testado também que
campos extras claramente maliciosos (`delete_file`, `exec`, `shell_command`,
`command`) numa resposta simulada do Groq são descartados por
`validateAndSanitizeResponse` e nunca aparecem no objeto sanitizado.

### 5. Schema validation

**VALIDADO**, com uma propriedade central comprovada explicitamente: **todo
desvio de tipo degrada pra menos ação, nunca pra mais**. Testado: prototype
pollution via chave `"__proto__"` (nunca escapa pro campo real, confirmado
que `JSON.parse` do Node trata isso como uma propriedade própria comum, não
como reatribuição de protótipo); arrays com 100.000 entradas (nunca crasham,
sempre cortados em 5); `confidence` como string, `Infinity` ou `NaN` (sempre
vira `0`, nunca um número alto por engano); `needs_human_review` como string
`"true"` (vira `false`, nunca dispara alerta indevido por coerção de tipo);
`classification` como objeto com `toString` disfarçado (nunca aceito por
coerção, sempre `'unknown'`).

### 6. Timeout/retry/circuit breaker/rate limit

**VALIDADO** após as correções F1 e F4 acima, com **2 riscos abertos
documentados** de baixa severidade (ver RISCOS ABERTOS #2 e #3). Testado:
circuit breaker abre após N falhas consecutivas e não tenta mais rede
nenhuma enquanto aberto (contagem de chamadas comprovada); rate limit
nunca deixa passar mais que o limite configurado mesmo sob rajada de 10
chamadas com limite de 3/min; retry com backoff cobre timeout, 5xx, 429,
JSON inválido, e agora DNS; erros HTTP/rede simulados (proxy devolvendo
HTML de erro, resposta JSON truncada no meio) nunca lançam exceção, sempre
terminam em `available:false`.

### 7. Isolamento por tenant

**VALIDADO** para o objetivo central (dados nunca se misturam entre bots),
com **1 risco aberto documentado** sobre THROUGHPUT/observabilidade (não
sobre vazamento de dados — ver RISCOS ABERTOS #4). Testado: botIds
adversariais nunca quebram o pipeline nem vazam crus; payload com mais de
20 eventos diferentes do mesmo bot é cortado em 20 (nunca vaza pro payload
de outro bot); **flood de 500 sinais idênticos do mesmo bot gera
exatamente 1 chamada ao Groq** (nunca 1 por sinal — resistente a
amplificação); flood no bot A nunca contamina a análise do bot B no mesmo
ciclo de poll (payloads permanecem completamente separados, cada um com
seu próprio `ref`/pseudônimo).

### 8. Ausência de secrets nos payloads

**VALIDADO.** Ver item 3 (redaction/allowlist) — os mesmos testes cobrem
isto diretamente: nenhum token, chave, caminho de arquivo sensível ou
botId real jamais aparece no `JSON.stringify()` do payload final, mesmo
adversarialmente forçado (caminho contendo `ENCRYPTION_KEY=...` cru,
botId parecido com uma chave AWS).

### 9. Comportamento com Groq indisponível

**VALIDADO.** Testado: `GROQ_API_KEY` ausente (nunca tenta rede); circuit
breaker aberto; rate limit excedido; timeout; erro HTTP genérico; DNS
falhando (agora com retry, ver F4); resposta HTML de proxy/erro (200 OK,
corpo texto em vez de JSON); resposta JSON truncada no meio. Em TODOS os
casos, `analyzeThreat()` nunca lança e sempre retorna
`{available:false, unavailableReason}` — nunca deixa o
`IncidentResponseManager`/`SecurityEngine` "esperando" nada. Testado
também que 50 falhas consecutivas do Groq nunca fazem `computeReadiness()`
retornar `BLOCKED`.

### 10. audit_log inexistente

**VALIDADO**, incluindo um cenário que a suíte anterior não cobria: desta
vez o teste chama `SecurityMonitor.pollAndEnqueue()` completo (não só
`SignalCollector.pollNewSecurityEvents()` isoladamente) contra um banco
onde NEM a tabela `bots` nem `audit_log` existem ainda — simulando um boot
limpo real de instalação nova. Confirmado que o caminho inteiro
(`ensureAuditTable()` sendo chamado de dentro de `pollNewSecurityEvents()`)
nunca lança.

### 11. Restart durante incidente

**VALIDADO** para a garantia central (Groq nunca reabre nem duplica um
incidente já resolvido), com **1 risco aberto documentado** sobre o cursor
do coletor (ver RISCOS ABERTOS #5). Testado: um incidente preso em estado
não-terminal (`'containing'`) é reconciliado como `failed_safe` (mesmo
mecanismo pré-existente da Fase 0, `reconcileStuckIncidents()`); depois
disso, 10 sugestões `likely_malicious` do Groq pro MESMO bot nunca criam
um segundo incidente, nunca mudam o status do primeiro, e — crucialmente —
**nunca alteram `bots.suspended`** (confirmando que o Groq não tem poder
nem pra ligar nem pra desligar a suspensão de um bot).

### 12. Estados READY/DEGRADED/BLOCKED

**VALIDADO.** Confirmado por teste estrutural que `SecurityMonitor.js`
nunca importa `serviceReadiness.js` (observação nunca é gateada pelo
estado do gate — comportamento intencional, documentado, e agora travado
por teste). Confirmado que 50 falhas consecutivas do Groq nunca resultam
em `BLOCKED`. Confirmado que uma config corrompida
(`config.security.groqMonitor` inteiramente ausente) nunca faz
`computeReadiness()` lançar nem virar `BLOCKED` por causa disso — o
try/catch existente absorve qualquer erro nessa seção como, no máximo,
mais um motivo `DEGRADED`. Confirmado que desabilitar o monitor limpa o
motivo DEGRADED mesmo com histórico de falhas ainda em memória.

---

## RISCOS ABERTOS (documentados e comprovados por teste — decisão deliberada de não alterar arquitetura sem necessidade real, conforme instrução)

Nenhum destes é explorável contra a garantia central ("Groq nunca ativa
CRITICAL/Kamikaze sozinho, nunca vaza secret, nunca bloqueia hospedagem").
São, no pior caso, características de disponibilidade/observabilidade
auxiliar — cada um comprovado por teste dedicado, nunca deixado como
suposição.

1. **`code`/`source` no payload não são validados contra um enum na
   camada de allowlist — só cortados por tamanho.** Hoje seguro na
   prática porque TODOS os chamadores atuais de `reportSignal()` usam
   strings fixas (confirmado por grep em `processManager.js`,
   `fileManager.js`, `monitorManager.js`). Mas a proteção real vive por
   CONVENÇÃO entre módulos, não por um check estrutural dentro de
   `redactPayload.js`. Se um FUTURO chamador de `reportSignal()` derivar
   `code`/`source` de algo menos confiável, esse valor (até 60/40 chars)
   chegaria ao prompt do Groq sem validação de enum — mitigado pelo resto
   da arquitetura (o modelo é instruído a tratar dados de evento como
   dado nunca como comando, e mesmo um "sequestro" bem-sucedido da
   classificação nunca ultrapassa HIGH). Teste:
   `RISCO ABERTO ... code/source não são validados contra um enum`.

2. **Circuit breaker permite mais de UMA tentativa de teste durante a
   transição OPEN → HALF_OPEN sob concorrência.** O guard síncrono só
   checa `circuitState === 'OPEN'`; assim que a primeira chamada
   concorrente já mudou pra `'HALF_OPEN'`, uma segunda chamada concorrente
   (dentro da concorrência de 2 da fila) também passa. Efeito prático:
   até 2 (não 1) tentativas de rede durante essa janela — não é bypass de
   segurança, ainda sujeitas a todo o resto do pipeline. Teste:
   `RISCO ABERTO ... mais de UMA tentativa de teste pode passar durante
   HALF_OPEN`.

3. **Rate limiter é de janela FIXA, não deslizante.** Uma rajada bem no
   fim de uma janela de 1 minuto seguida de outra rajada logo no início
   da próxima pode, em teoria, permitir até 2x o limite configurado numa
   janela de tempo curta cruzando a borda. Característica conhecida e
   aceita de rate limiters de janela fixa — não corrigido por não ser
   necessário pra segurança (é controle de custo/abuso da NOSSA própria
   chamada de saída, não uma fronteira de segurança sendo testada contra
   um adversário externo).

4. **Um bot que gera muitos sinais DIFERENTES pode consumir o
   `MAX_ROWS_PER_POLL` (500) inteiro por vários ciclos de poll,
   atrasando a observação AUXILIAR de outros bots** (nunca afeta o
   Kamikaze determinístico, que é instantâneo e independente por bot).
   Circuit breaker e rate limit já são globais por design (um único
   dependente externo) — isto é o reflexo natural disso. Não corrigido:
   uma solução justa exigiria paginação por bot em vez de uma única
   query global ordenada por id, o que é uma mudança de arquitetura não
   claramente necessária pra um recurso auxiliar.

5. **Cursor do `SignalCollector` reseta a 0 em cada restart real do
   processo** (é estado de módulo em memória, nunca persistido). Um
   restart faz o coletor reprocessar TODO o histórico de
   `security_signal:*` desde o início, o que pode gerar uma rajada de
   chamadas ao Groq (mitigada pelo rate limit/circuit breaker já
   existentes) e atrasar a observação de sinais NOVOS até o backlog
   drenar. Nunca reduz segurança (Kamikaze determinístico não depende
   disso; o pior efeito é sinais do Groq re-encaminhados, ainda incapazes
   de ultrapassar HIGH). Não corrigido: uma correção real exigiria
   persistir o cursor (nova coluna/tabela) — mudança de schema não
   justificada pra um recurso cujo pior efeito é atraso de observação
   auxiliar. Teste: `RISCO ABERTO ... cursor do SignalCollector reseta a
   0 num restart real, replay de todo o histórico` — prova o
   comportamento com um poll paginado exatamente como aconteceria em
   produção.

6. **Chamada ao Groq sob rede comprometida/MITM ainda depende do timeout
   próprio do axios pra realmente abortar a conexão.** O timeout da FILA
   (`queueManager.js`) não cancela a chamada de rede real — só libera o
   slot da fila mais cedo (`Promise.race`, a outra Promise continua
   rodando em segundo plano). Com F1 corrigido, isto só importa se o
   axios FALHAR em respeitar seu próprio `timeout` configurado — um
   cenário de baixa probabilidade, fora do controle direto desta
   plataforma.

7. **`pseudonymFor()` trunca SHA-256 pra 10 hex chars (40 bits).** Risco
   de colisão teórico, impraticável na escala atual/esperada da
   plataforma (limiar de 50% de colisão por aniversário fica perto de
   ~1 milhão de bots simultaneamente rastreados). Não corrigido por não
   ser necessário na escala real.

---

## NÃO VALIDADO (mesma categoria da Fase 2 original, reafirmada nesta revisão)

- **Chamada de rede real ao Groq**: nenhuma chamada HTTP real ao
  `api.groq.com` foi feita durante esta revisão (nem durante a Fase 2
  original) — toda verificação usa injeção de dependência ou substituição
  local do `axios.post`, por instrução explícita de não usar secrets
  reais.
- **Qualidade das sugestões do modelo em produção real** — fora do
  escopo de uma revisão de segurança (mesmo uma sugestão ruim do Groq não
  consegue causar dano, pelas garantias estruturais desta revisão).

## DEPENDE DE VPS (reafirmado)

- Conectividade de saída real para `api.groq.com`, latência real,
  validade/cota da `GROQ_API_KEY` de produção — nada disto muda com esta
  revisão, que não fez deploy nem usou secrets reais.

---

## Conclusão

A garantia central da Fase 2 — **Groq é estritamente auxiliar e nunca,
sob nenhuma combinação testada (adversarial ou não), consegue ativar
CRITICAL/Kamikaze sozinho, vazar um secret real, ou bloquear hospedagem**
— resistiu a esta revisão adversarial. Os 4 achados reais encontrados
eram de robustez/precisão operacional (margem de timeout, teto de
tamanho de resposta, cobertura de retry), não de bypass de segurança, e
foram corrigidos com mudanças mínimas e cirúrgicas, sem alterar a
arquitetura. Os 7 riscos abertos documentados são conhecidos,
comprovados por teste, e nenhum compromete a garantia central — ficam
registrados para quando a escala real da plataforma justificar revisitá-los.

**Recomendação:** a Fase 2 está pronta, sob esta revisão, para servir de
base pra arquitetura do sistema comercial.

## Documentos relacionados

- `SECURITY_MONITOR.md` — arquitetura da Fase 2 e relatório de entrega original.
- `SECURITY_ARCHITECTURE.md` — visão geral de trust boundaries.
- `tests/securityPhase2Adversarial.test.js` — os 38 testes desta revisão.
