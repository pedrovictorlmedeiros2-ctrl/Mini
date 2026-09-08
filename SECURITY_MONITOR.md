# SECURITY_MONITOR.md — SecurityMonitor + Groq (Kamikaze Fase 2)

Arquitetura e relatório final da Fase 2: um analisador **auxiliar** baseado
em Groq, que observa os mesmos sinais que já alimentam o Kamikaze
determinístico (Fase 0/1) e pode, no máximo, **sugerir** uma classificação —
nunca decidir, nunca agir. Este documento assume que o leitor já conhece
`SECURITY_ARCHITECTURE.md` e o Kamikaze determinístico (`SecurityEngine.js`,
`IncidentResponseManager.js`).

---

## 1. Por que isto nunca pode enfraquecer o Kamikaze

Duas garantias independentes, cada uma suficiente sozinha:

**(a) Isolamento de módulo.** `GroqThreatAnalyzer.js` é importado por
exatamente um arquivo: `ThreatDecisionPolicy.js`. Nem `SecurityEngine.js`
nem `IncidentResponseManager.js` importam Groq, direta ou indiretamente —
confirmável com `grep -rn "GroqThreatAnalyzer\|require.*groq" src/managers/security/*.js`
(zero ocorrências fora de `monitor/`). O caminho determinístico não tem
NENHUMA dependência de código no Groq — se o arquivo `GroqThreatAnalyzer.js`
fosse apagado inteiro, o Kamikaze da Fase 0/1 continuaria compilando e
funcionando sem alteração nenhuma.

**(b) Teto estrutural de severidade.** Os únicos dois `code`s que o Groq
pode gerar (`groq_suggested_suspicious`, `groq_suggested_high`) são
deixados de fora, deliberadamente, do mapa `SIGNAL_CATEGORY` em
`SecurityEngine.js` (arquivo não modificado nesta fase). Isso os classifica
como categoria `'unknown'` — e a regra de correlação que decide CRITICAL já
faz `highCategories.delete('unknown')` antes de contar categorias
independentes (código pré-existente, da Fase 0). Resultado: repetição de
sinais do Groq pode escalar até HIGH (a regra genérica de "N ocorrências do
mesmo código na janela" não distingue a origem), mas **nunca** chega a
CRITICAL, nem sozinho nem correlacionado com outro sinal do Groq. Só
evidência dura (allowlist fixa) ou correlação de duas categorias
determinísticas HIGH ativam CRITICAL — exatamente como antes desta fase.

Ambas as garantias têm teste dedicado (`GROQ SOZINHO NUNCA ATIVA KAMIKAZE`,
em `threatDecisionPolicy.test.js` e de novo em `securityMonitor.test.js`,
repetindo Groq com confiança 0.99 vinte vezes seguidas no mesmo bot).

---

## 2. Fluxo de dados (ponta a ponta)

```
┌──────────────┐  reportSignal()   ┌───────────────┐
│ fontes de     │──────────────────▶│ SecurityEngine │── audit_log (append-only,
│ sinal (Fase 0)│   (inalterado)     │  (inalterado)  │   já existia)
└──────────────┘                    └───────┬────────┘
                                             │ escreve TODO sinal, sempre
                                             ▼
                                   ┌───────────────────┐
                                   │ audit_log          │
                                   │ action LIKE         │
                                   │ 'security_signal:%' │
                                   └─────────┬───────────┘
                                             │ lido de forma incremental
                                             │ (cursor por id, nunca reprocessa)
                                             ▼
                              ┌─────────────────────────┐
                              │ SignalCollector.js        │  agrupa por botId,
                              │ pollNewSecurityEvents()    │  resume por código
                              └─────────────┬───────────────┘  (nunca mistura tenants)
                                            │ Map<botId, eventos resumidos>
                                            ▼
                              ┌─────────────────────────┐
                              │ SecurityMonitor.js         │  1 tarefa POR BOT,
                              │ pollAndEnqueue() (timer,    │  enfileirada em
                              │ nunca bloqueia)             │  queueManager.js
                              └─────────────┬───────────────┘  (prioridade 'low')
                                            ▼
                              ┌─────────────────────────┐
                              │ redactPayload.js           │  ALLOWLIST estrita —
                              │ buildGroqEventPayload()     │  nenhum campo de
                              └─────────────┬───────────────┘  texto livre
                                            ▼
                              ┌─────────────────────────┐
                              │ GroqThreatAnalyzer.js      │  timeout, retry+backoff,
                              │ analyzeThreat()             │  circuit breaker, rate
                              └─────────────┬───────────────┘  limit, schema estrito
                                            │ {classification, confidence, ...}
                                            ▼
                              ┌─────────────────────────┐
                              │ ThreatDecisionPolicy.js    │  ÚNICO ponto que pode
                              │ applyThreatDecision()       │  chamar reportSignal()
                              └─────────────┬───────────────┘  de volta
                                            │ reportSignal({code: groq_suggested_*})
                                            ▼
                                   ┌───────────────┐
                                   │ SecurityEngine │  reentra no MESMO pipeline
                                   │  (inalterado)  │  determinístico de sempre
                                   └───────┬────────┘
                                           │ code Groq → categoria 'unknown'
                                           │ (nunca elegível a CRITICAL sozinho)
                                           ▼
                              (HIGH possível por repetição; CRITICAL NUNCA
                               só por sinal do Groq — ver seção 1)
```

Nenhuma seta deste diagrama pula uma etapa: o Groq nunca fala direto com
`IncidentResponseManager`, nunca escolhe `botId`/caminho (vêm sempre do
`SignalCollector`, que leu do banco), e nunca decide uma ação — só devolve
uma sugestão que passa pelo mesmo funil determinístico de sempre.

---

## 3. Módulos novos

| Arquivo | Responsabilidade | Nunca faz |
|---|---|---|
| `redactPayload.js` | Allowlist estrita (`code`/`source`/`category`/`severity`/contagens/timestamps/pseudônimo de botId/hash de caminho) + scrub de texto livre como defesa em profundidade | Incluir qualquer campo de texto livre não redigido no payload final |
| `GroqThreatAnalyzer.js` | Chamada HTTP ao Groq com timeout curto, retry limitado com backoff exponencial, circuit breaker (CLOSED/OPEN/HALF_OPEN), rate limit próprio por minuto, validação estrita de schema da resposta | Decidir qualquer ação; usar texto livre (`summary`) pra decidir algo; propagar campo não-enumerado |
| `ThreatDecisionPolicy.js` | Único lugar que pode alimentar `SecurityEngine.reportSignal()` com um sinal originado do Groq; gate de confiança mínima; alerta de "revisão humana" só pro canal admin | Importar `IncidentResponseManager`; apagar arquivo, restaurar snapshot, revogar credencial, executar comando; deixar o Groq escolher `botId`/caminho |
| `SignalCollector.js` | Leitura incremental (cursor por `id`) do `audit_log`, agrupada por bot, nunca reprocessa linha | Escrever no banco; misturar eventos de bots diferentes num mesmo grupo |
| `SecurityMonitor.js` | Orquestrador: timer não-bloqueante → enfileira 1 análise por bot em `queueManager.js` (fila já existente) → mede saúde operacional do Groq | Chamar Groq diretamente (só via `GroqThreatAnalyzer`); esperar (`await`) uma chamada ao Groq dentro do próprio timer |

---

## 4. Configuração

Ver `.env.example` (seção "KAMIKAZE MODE" / "SecurityMonitor + Groq") para
a lista comentada completa. Resumo:

| Variável | Default | Efeito |
|---|---|---|
| `GROQ_API_KEY` | (vazia) | Sem ela, `GroqThreatAnalyzer` nunca tenta rede — retorna indisponível na hora |
| `GROQ_MONITOR_ENABLED` | `true` | `false` desliga o monitor por completo (Kamikaze determinístico intacto) |
| `GROQ_MONITOR_POLL_INTERVAL_MS` | `30000` | Frequência de leitura do `audit_log` |
| `GROQ_MONITOR_TIMEOUT_MS` | `5000` | Timeout por chamada individual |
| `GROQ_MONITOR_MAX_RETRIES` | `1` | Tentativas adicionais (só erros retryable: timeout/5xx/429/JSON inválido) |
| `GROQ_MONITOR_RATE_LIMIT_PER_MIN` | `20` | Teto próprio de chamadas por minuto |
| `GROQ_MONITOR_CIRCUIT_THRESHOLD` | `5` | Falhas consecutivas que abrem o circuito |
| `GROQ_MONITOR_CIRCUIT_COOLDOWN_MS` | `120000` | Cooldown até a próxima tentativa de teste (HALF_OPEN) |
| `GROQ_MONITOR_MIN_CONFIDENCE` | `0.6` | Confiança mínima pra sequer virar um sinal no SecurityEngine |
| `GROQ_MONITOR_DEGRADED_AFTER_FAILURES` | `5` | Falhas operacionais seguidas até `serviceReadiness.js` reportar DEGRADED |

---

## 5. Relatório final — Fase 2

### VALIDADO

- **Isolamento de módulo**: Groq nunca é importado por `SecurityEngine.js`
  nem `IncidentResponseManager.js` — confirmado por grep, não só por
  comentário.
- **Groq nunca ativa CRITICAL sozinho**: testado com 20 respostas
  `likely_malicious`/confiança 0.99 seguidas no mesmo bot, em dois níveis
  (`ThreatDecisionPolicy` isolado e via `SecurityMonitor.analyzeBotEvents`
  ponta a ponta) — zero incidentes criados em ambos.
- **Um único sinal SUSPICIOUS nunca ativa Kamikaze** — testado.
- **Evidência dura continua ativando CRITICAL** mesmo com ruído simultâneo
  do Groq no mesmo bot (10 sugestões `likely_malicious` intercaladas com um
  sinal `platform_secret_path_blocked`) — testado, resultado idêntico ao
  comportamento pré-Fase-2.
- **Dois sinais determinísticos independentes continuam ativando CRITICAL**
  por correlação, mesmo com o Groq ativo no mesmo bot — testado.
- **Groq offline/indisponível não afeta o Kamikaze determinístico** —
  testado (Groq retornando `available:false` em loop, evidência dura
  dispara CRITICAL normalmente).
- **Resposta inválida/malformada nunca causa ação**: JSON inválido, campo
  fora do enum, campo inesperado, resposta não-objeto — todos caem em
  `unknown`/defaults seguros, nunca lançam exceção, nunca são propagados —
  testado (`groqThreatAnalyzer.test.js`, 10 testes).
- **Nenhum texto livre decide nada**: `summary` do Groq só é redigido e
  guardado como contexto pra humano — nunca participa de `applyThreatDecision`.
- **Prompt injection em log é tratado como dado**: o `SYSTEM_PROMPT` instrui
  isso explicitamente, e mesmo que ignorado, o payload que chega ao Groq
  não carrega texto livre nenhum vindo de log — só campos enumerados (ver
  próximo item).
- **Redação/allowlist antes de qualquer envio**: nenhum campo de texto livre
  arbitrário existe no payload final — testado com 13 casos, incluindo
  truncamento, blob de secret genérico, marcador de arquivo sensível da
  plataforma (`.env`, `hosting.db`, `ENCRYPTION_KEY`, `GITHUB_WEBHOOK_SECRET`),
  payload circular, payload excessivo (>20 eventos truncado).
- **Isolamento de tenant**: `SignalCollector` nunca mistura eventos de bots
  diferentes no mesmo grupo; `SecurityMonitor` enfileira uma tarefa por bot
  com payload/pseudônimo próprios — testado com dois bots simultâneos em
  ambos os módulos, além do teste de isolamento em `ThreatDecisionPolicy`
  (sinal de um bot nunca aparece em nome de outro).
- **IDs/caminhos sempre vêm do pipeline interno**: `botId` é passado pelo
  `SignalCollector` (leu do banco), nunca inferido de nada que o Groq
  devolve; o Groq nunca ecoa nem escolhe nenhum identificador.
- **Fila assíncrona / processo principal nunca bloqueia**: testado
  diretamente — `pollAndEnqueue()` retorna em poucos milissegundos mesmo
  com uma análise Groq simulada de 300ms em andamento; a chamada real ao
  Groq roda dentro de `queueManager.js` (concorrência limitada, timeout por
  tarefa, prioridade `'low'`), nunca inline no timer.
- **Retry, backoff exponencial e circuit breaker**: testados explicitamente
  (erro retryable vs não-retryable, sequência de backoff, abertura do
  circuito após N falhas consecutivas, transição pra HALF_OPEN após
  cooldown, reset em sucesso).
- **Rate limit próprio**: testado (janela fixa de 1 minuto, nunca depende só
  do rate limit do lado do Groq).
- **GROQ_API_KEY ausente**: nunca tenta rede nenhuma — testado.
- **Saúde operacional só conta chamadas reais**: "desabilitado"/"sem chave"
  nunca incrementam o contador de falhas usado pro DEGRADED — testado
  explicitamente (habilitar/desabilitar no meio do teste).
- **DEGRADED nunca BLOCKED**: indisponibilidade prolongada do Groq só soma
  um motivo em `degradedReasons` — nunca em `blockedReasons` — testado, e
  também testado que desligar o monitor remove o motivo mesmo com histórico
  de falhas ainda em memória.
- **Suíte completa sem regressão**: 181 testes, 176 passando, 0 falhas, 5
  skips (mesmo baseline de antes da Fase 2 + 50 testes novos desta fase:
  13 + 10 + 11 + 8 + 8, distribuídos em `redactPayload.test.js`,
  `groqThreatAnalyzer.test.js`, `threatDecisionPolicy.test.js`,
  `signalCollector.test.js`, `securityMonitor.test.js`).

### NÃO VALIDADO (fora do escopo real desta fase, feito com stubs/injeção)

- **Chamada de rede real ao Groq**: por instrução explícita ("não use
  secrets reais durante os testes"), todo o comportamento de rede foi
  testado via injeção de dependência (`options.httpPost` em
  `GroqThreatAnalyzer`, `_setAnalyzeThreatForTests` em `SecurityMonitor`) —
  nunca houve uma chamada HTTP real ao `api.groq.com` durante esta fase.
  O contrato de request/response foi validado contra o formato documentado
  da API (mesmo padrão já usado em `diagnosticManager.js`, pré-existente),
  não contra uma resposta real capturada.
- **Qualidade das sugestões do Groq em produção**: se o modelo classifica
  bem ou mal um padrão real de abuso é uma questão de eficácia do modelo,
  não de segurança do pipeline — não avaliada aqui (e não é o objetivo desta
  fase: mesmo uma sugestão ruim do Groq não consegue causar dano, pelas
  garantias da seção 1).
- **Comportamento sob carga real de produção** (muitos bots, muitos sinais
  simultâneos, fila `queueManager.js` sob pressão real): testado com poucos
  bots/eventos sintéticos, não com volume de produção.

### DEPENDE DE VPS (não pode ser confirmado neste ambiente de teste)

- **Conectividade de rede de saída para `api.groq.com`** no host de
  produção — pode estar bloqueada por firewall/proxy, o que faria todo
  `analyzeThreat()` cair em timeout (comportamento já coberto: vira
  `unavailable`, Kamikaze determinístico segue igual, e depois de
  `GROQ_MONITOR_CIRCUIT_THRESHOLD` falhas o circuit breaker abre e para de
  tentar por `GROQ_MONITOR_CIRCUIT_COOLDOWN_MS`).
- **Latência real da API do Groq** sob a rede específica da VPS — o timeout
  default (`GROQ_MONITOR_TIMEOUT_MS=5000`) pode precisar de ajuste conforme
  a latência observada em produção.
- **Volume real de sinais de segurança** no host — determina a pressão real
  sobre `GROQ_MONITOR_RATE_LIMIT_PER_MIN` e sobre a fila de baixa prioridade
  em `queueManager.js` (compartilhada com outras tarefas de baixa
  prioridade da plataforma).
- **Confirmação de que a variável `GROQ_API_KEY` de produção é válida e tem
  cota disponível na conta Groq** — sem uma chave real, o monitor roda
  "desligado na prática" (retorna indisponível na hora, sem tentar rede),
  o que é o comportamento fail-closed correto, mas só pode ser confirmado
  como "de fato funcionando com o Groq real" na VPS, com uma chave real.

### RISCOS ABERTOS

- **Custo/cota da API do Groq**: com `GROQ_MONITOR_POLL_INTERVAL_MS=30000`
  e muitos bots com sinais de segurança, o volume de chamadas pode crescer
  proporcionalmente ao número de bots ativos e à frequência de sinais —
  mitigado pelo rate limit próprio (`GROQ_MONITOR_RATE_LIMIT_PER_MIN`), mas
  o operador deve monitorar o consumo/cota da própria conta Groq (fora do
  controle desta plataforma).
- **Falso positivo do Groq gerando alerta de "revisão humana"**: um alerta
  administrativo (`sendAlert`, canal admin, nunca DM ao dono do bot) pode
  ser disparado por uma sugestão do Groq mesmo quando não há nada de errado
  — impacto limitado (é só uma notificação, nenhuma ação automática), mas é
  um vetor de "alarme fatigue" se o modelo for ruidoso; não medido nesta
  fase (ver "NÃO VALIDADO" acima).
- **Dependência de uma chave de API compartilhada** com o recurso
  pré-existente de diagnóstico (`diagnosticManager.js`) — os dois recursos
  usam a mesma `GROQ_API_KEY` e compartilham cota/rate-limit do lado do
  Groq (não do lado desta plataforma, que já tem rate limit próprio por
  recurso). Um consumo alto do diagnóstico por IA pode reduzir a cota
  disponível pro SecurityMonitor, e vice-versa — não há isolamento de cota
  entre os dois no lado do Groq.
- **`queueManager.js` é compartilhado** com outras tarefas de baixa
  prioridade da plataforma — um pico de tarefas de segurança (muitos bots
  gerando sinais ao mesmo tempo) pode atrasar outras tarefas de baixa
  prioridade não relacionadas a segurança (ex.: limpeza/manutenção). Isso é
  uma escolha deliberada (reuso da fila existente em vez de duplicar
  infraestrutura), mas fica registrado como risco a observar sob carga real.
- **`GROQ_MONITOR_DEGRADED_AFTER_FAILURES` é contado por tentativa
  operacional, não por janela de tempo fixa**: se o poll interval for muito
  curto e houver poucos bots ativos, "5 falhas seguidas" pode levar muito
  menos tempo real do que se houver muitos bots (cada `pollAndEnqueue`
  pode gerar várias tentativas quase simultâneas). O sinal DEGRADED ainda é
  correto (indica falhas reais recentes), mas o tempo até aparecer varia
  com o volume de bots — documentado aqui, não considerado um defeito.

---

## Documentos relacionados

- `SECURITY_MONITOR_REVIEW.md` — revisão de segurança adversarial desta
  fase (achados corrigidos + riscos abertos, com testes).
- `SECURITY_ARCHITECTURE.md` — visão geral de trust boundaries e camadas.
- `THREAT_MODEL.md` — quem é o atacante, o que ele controla.
- `SECURITY_AUDIT.md` — achados de auditoria com reprodução.
- `SANDBOX.md` — isolamento de kernel em detalhe.
- `SECURITY_LIMITATIONS.md` — o que não está protegido hoje.
- `DEPLOY.md` — operação persistente (systemd/PM2), Fase 1.
