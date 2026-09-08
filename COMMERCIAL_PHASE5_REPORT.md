# Fase 5 — Pix + Armazenamento Protegido de Comprovantes

Relatório final da Fase 5, autorizada sobre o commit `64df585` (Fase 4 validada). Escopo: endurecer toda a infraestrutura de Pix e comprovantes já existente (desde a Fase 3), fechando lacunas específicas de segurança/concorrência/retenção pedidas explicitamente, sem tocar em aprovação/rejeição de pagamento, provisionamento ou qualquer item fora de escopo.

## 1) Arquivos criados/alterados

**Novo:**
- `tests/commercePhase5Adversarial.test.js` — 46 testes adversariais.

**Alterados:**
- `src/managers/commerce/ProofManager.js` — hardening completo (ver seção 4).
- `src/database/database.js` — migração `commerce_proofs.purged_at` (movida pra depois da criação da tabela — ver "Erros e correções" abaixo).
- `config.js` — `commerce.proofRetentionDays` (default 180 dias, env `COMMERCE_PROOF_RETENTION_DAYS`).
- `src/managers/commerce/CommerceScheduler.js` — nova `sweepExpiredProofs()`, adicionada em `runAllSweeps()`.
- `tests/commerceProofManager.test.js`, `tests/commercePhase3Adversarial.test.js` — URLs de anexo trocadas de placeholders (`'x'`/`'y'`) para URLs reais de `cdn.discordapp.com`, exigido pela nova allowlist de host (ver seção 4).

## 2) Arquitetura do armazenamento

- **Diretório privado**: `config.commerce.proofsFolder` (default `./commerce-proofs`, fora de qualquer pasta servida por HTTP — confirmado por busca no projeto inteiro: nenhum `express.static`/`res.sendFile` existe em lugar nenhum do código, muito menos apontando pra essa pasta).
- **Convenção de nomes**: sempre `${crypto.randomUUID()}.enc` — nunca derivado do nome enviado pelo cliente. Isso por si só já neutraliza qualquer path traversal via nome de arquivo (a extensão/nome do cliente é usada só pra comparar contra o CONTEÚDO real, nunca pra montar um caminho).
- **Permissões**: diretório `0700`, arquivo `0600` — só o processo dono lê. Aplicado tanto na criação quanto reforçado (`chmodSync`) em toda escrita, cobrindo também diretórios criados por deploys anteriores à Fase 5.
- **Escrita não-destrutiva**: `fs.writeFileSync(..., { flag: 'wx' })` — falha em vez de sobrescrever se o caminho já existir (defesa contra colisão de UUID, praticamente impossível, mas testada forçando a colisão).
- **Isolamento por order_id/usuário**: toda consulta é sempre filtrada por `order_id`, e toda leitura decriptada exige `hasCommercePermission()` — nunca existe uma função pública que devolva o conteúdo de um comprovante sem essa checagem, nem pro próprio dono do pedido.
- **Retenção configurável**: `purgeExpiredProofs()` — só remove o ARQUIVO de comprovantes já `accepted`/`rejected` mais velhos que `proofRetentionDays`; um comprovante `submitted` (pendente de revisão) nunca é purgado, não importa a idade. A LINHA no banco nunca é apagada (audit trail permanente); só `storage_path` fica órfão e `purged_at` é gravado, o que já faz `getDecryptedProof` recusar qualquer tentativa de leitura.
- **Recuperação sem exposição pública**: `ProofManager.getDecryptedProof()` é a ÚNICA função que decripta — sempre em memória, devolvida como Buffer pro chamador (que hoje é só `commerce.js`, montando um `AttachmentBuilder` numa resposta ephemeral do Discord). Nenhum endpoint HTTP foi criado nesta fase.

## 3) Criptografia e chaves

Reaproveitado `src/utils/fileCrypto.js` (já existente desde os backups, não uma criptografia "caseira" desta fase):
- **AES-256-GCM** (autenticada) via `crypto` nativo do Node — biblioteca madura, não um algoritmo inventado.
- Chave de 256 bits derivada por **scrypt** a partir de `ENCRYPTION_KEY` (variável de ambiente) + um **salt aleatório por arquivo** (16 bytes) — dois comprovantes com o mesmo conteúdo nunca produzem o mesmo blob cifrado (testado).
- **IV aleatório por arquivo** (12 bytes, recomendado pra GCM) + **authTag** (16 bytes) — qualquer byte alterado no arquivo (corrupção ou adulteração) faz a decriptação falhar explicitamente, nunca devolve lixo silenciosamente (testado).
- **Chave nunca fica junto do arquivo**: só `[salt][iv][authTag][ciphertext]` vão pro disco; a chave em si (`ENCRYPTION_KEY`) existe só em memória/variável de ambiente, nunca escrita em nenhum arquivo de comprovante nem logada (testado: o conteúdo cifrado nunca contém a chave como substring).
- **Rotação futura**: não implementada nesta fase (não foi pedido, só "considerar"). Documentando a limitação: hoje existe uma única `ENCRYPTION_KEY` global; trocar essa variável quebraria a decriptação de comprovantes já gravados (o salt é por arquivo, mas a passphrase-base é única). Uma rotação real exigiria versionar o formato do arquivo cifrado (um byte de versão no início, hoje inexistente) pra tentar a chave certa por versão — deliberadamente não implementado agora pra não alterar o formato binário também usado por `backupManager.js` (mesmo módulo `fileCrypto.js`) sem necessidade nesta fase.

## 4) Limites de upload e decisões de segurança

| Controle | Onde | Comportamento |
|---|---|---|
| Tamanho declarado | `attachment.size` | Recusado cedo se > `maxProofSizeBytes` (checagem barata, não autoritativa) |
| **Content-Length (novo)** | header da resposta do fetch | Recusado ANTES de baixar o corpo inteiro, se o header já denunciar um arquivo grande demais — nunca confia só nisso (pode faltar/mentir), mas evita consumir memória à toa no caso comum |
| Tamanho real | `buffer.length` após download | Autoritativo — sempre checado, independente do que foi declarado |
| Tipo por conteúdo | magic bytes (JPEG/PNG/WEBP/PDF) | Allowlist estrita — qualquer coisa fora disso (executável, ZIP, etc.) é recusada pelo CONTEÚDO, nunca só por extensão/MIME declarado |
| Extensão × conteúdo | `path.extname` vs. tipo detectado | Precisam bater — cobre extensão dupla (`fatura.pdf.exe`, `fatura.exe.pdf`) |
| MIME declarado × conteúdo | `Content-Type` vs. tipo detectado | Precisam bater |
| **Nome do arquivo (novo)** | `sanitizeFilename()` | `path.basename` (remove qualquer diretório) + normalização Unicode (NFC) + remoção de caracteres de controle + truncamento (150 chars) — usado só pra EXIBIÇÃO/histórico, nunca pra montar um caminho real |
| **Origem da URL (novo — achado da revisão adversarial)** | allowlist de host | Só `cdn.discordapp.com`/`media.discordapp.net`, `https` — fecha um SSRF/DoS latente: sem isso, nada impedia (por bug futuro ou uso deste manager fora do fluxo normal do Discord.js) que `submitProof()` fizesse o servidor baixar uma URL arbitrária |
| **Escrita não-destrutiva (novo)** | flag `wx` | Nunca sobrescreve um arquivo existente — falha explicitamente |
| **Re-checagem persistente (novo)** | estado do pedido reconferido no banco, síncrono, imediatamente antes do INSERT | Fecha a janela real de corrida entre o início do download (que pode levar segundos) e a gravação — não depende só do lock em memória da Fase 4 |

## 5) Permissões (revalidado nesta fase)

- **Cliente**: só envia/acessa o próprio comprovante — `submitProof()` sempre revalida `order.user_id === uploaderUserId` contra o banco, nunca contra o que o chamador alega.
- **CommerceStaff**: só revisa comprovantes via `getDecryptedProof()`, que exige `hasCommercePermission()` — checado dentro do manager, nunca só na camada de UI.
- **Staff revogado**: perde acesso imediatamente (a checagem é sempre contra `commerce_staff.revoked_at IS NULL` no momento da chamada, nunca cacheada) — e agora a tentativa negada também é **auditada** (`commerce:proof_access_denied`), o que não existia antes desta fase.
- **Administrator**: mantém autoridade administrativa via `hasCommercePermission()` (que inclui admin).
- Nunca depende de visibilidade de canal do Discord como mecanismo de segurança — reafirmado, sem mudança de comportamento (já era assim desde a Fase 3/4).

## 6) Máquina de estados

Sem alteração na máquina em si (`OrderManager.VALID_TRANSITIONS`) nem no primitivo CAS (`transitionOrder`). `submitProof()` continua só levando `AWAITING_PAYMENT → PROOF_SUBMITTED`; nunca `CONFIRMED`/`APPROVED` — enviar comprovante nunca é confundido com pagamento aprovado (isso continua exclusivo de `PaymentManager.confirmPayment()`, fora de escopo desta fase e não tocado).

## 7) Concorrência

Conforme pedido explicitamente ("não depender exclusivamente de lock em memória"): `submitProof()` agora faz uma **re-checagem síncrona contra o banco imediatamente antes do INSERT** — sem nenhum `await` entre essa leitura e a escrita, então não existe nova janela de corrida ali (Node é single-threaded, driver SQLite síncrono). Isso fecha o cenário real que o lock em memória da Fase 4 (`activeProofCollectors`, na camada de UI) não cobria: uma chamada a `submitProof()` que já passou da checagem inicial, mas ainda está no meio do download (que pode levar segundos), enquanto o pedido muda de estado por outro caminho (staff abre revisão, cliente cancela, scheduler expira o carrinho). O lock em memória continua existindo como otimização de UX (evita criar dois `MessageCollector`), mas não é mais a única barreira. Testado com um cenário real de corrida (fetch pendurado deliberadamente, transição do pedido no meio, depois resolvido).

## 8) Auditoria

Registrado (conforme pedido): comprovante recebido, comprovante visualizado, comprovante rejeitado (tipo inválido/estado obsoleto/URL inválida), **tentativa de acesso negada (novo)**, alterações na configuração Pix. Nunca registrado: chave Pix completa, tokens, senhas, conteúdo do comprovante, qualquer dado sensível desnecessário — confirmado por busca em todo o código comercial (nenhuma ocorrência de log/print de `pix_key`/`pix_name`/`pix_city`, só leituras/gravações no banco e exibição legítima ao comprador durante o próprio fluxo de pagamento).

## 9) Testes criados (46 novos + 2 arquivos existentes ajustados)

`tests/commercePhase5Adversarial.test.js`, por seção: path traversal (3 variantes + 1 teste estrutural), Unicode/controle, extensão dupla (2 variantes), MIME/Content-Type forjados (2 ângulos), vazio/oversized/nome gigante/ZIP/executável/conteúdo-válido-com-lixo, overwrite forçado (colisão de UUID simulada), order_id manipulado (2 variantes), terceiros, estado inválido (4 status), **TOCTOU real** (2 cenários: cancelamento e abertura de revisão durante o download), concorrência legítima determinística, SSRF (5 testes: host errado, protocolo errado, host por substring, URL malformada, host correto aceito), Content-Length antecipado, staff revogado + auditoria, acesso direto ao armazenamento (ciphertext puro, sem chave), permissões de arquivo/diretório, ausência de endpoint público, snapshot do Pix, auditoria do Pix sem vazar chave, retenção (4 cenários), criptografia (2 cenários).

## 10) Resultado da suíte completa (3 execuções para estabilidade)

```
tests 423
pass 418
fail 0
cancelled 0
skipped 5
```
Idêntico nas três execuções consecutivas — sem flakiness, mesmo com os novos testes de concorrência real (TOCTOU) e collector simulado. 0 regressões (405→423 com as fases anteriores incluídas; 46 testes novos desta fase, 2 arquivos de fases anteriores ajustados só por causa da nova allowlist de URL, nenhuma lógica de teste alterada).

## 11) Riscos encontrados e corrigidos nesta fase

1. **SSRF/DoS latente via `attachment.url`** — achado na revisão adversarial final, corrigido com allowlist de host (`cdn.discordapp.com`/`media.discordapp.net`, só `https`) antes de qualquer `fetch()`. Não era explorável no fluxo normal do Discord.js (que sempre popula URLs reais de CDN), mas violava o princípio de nunca confiar em campo nenhum do anexo — corrigido como defesa em profundidade.
2. **Corrida real (TOCTOU) entre início do download e gravação** — corrigida com a re-checagem síncrona persistente descrita na seção 7.
3. **Nome de arquivo nunca sanitizado antes de reexibição** — corrigido com `sanitizeFilename()` (a exposição real era cosmética/de exibição pro staff, já que o nome nunca era usado pra montar um caminho, mas ainda assim corrigido).
4. **Tentativas de acesso negado a comprovante não eram auditadas** — corrigido.
5. **Sem retenção configurável pra comprovantes** — implementada nesta fase (`purgeExpiredProofs`, `sweepExpiredProofs`, config `proofRetentionDays`).
6. **Permissões de arquivo/diretório não eram explicitamente restringidas** — corrigido (0700/0600).

## 12) Limitações conhecidas (documentadas, não bloqueantes)

1. **Rotação de chave de criptografia não implementada** — ver seção 3. Considerada, não construída (fora do pedido explícito desta fase).
2. **`Content-Length` pode faltar ou mentir** — a checagem antecipada é só uma otimização; o limite real continua sendo aplicado sobre `buffer.length` após o download completo.
3. **Retenção default (180 dias)** é um valor conservador até existir uma definição jurídica/operacional formal — configurável via `COMMERCE_PROOF_RETENTION_DAYS`, decisão de negócio explicitamente fora do escopo técnico desta fase.
4. **Locks em memória (Fase 4) não sobrevivem a um restart** — aceitável, já documentado no relatório da Fase 4; a garantia real (persistente) foi adicionada nesta fase exatamente para não depender só deles.
5. Nenhuma mudança em `SecurityEngine`, `IncidentResponseManager`, `Kamikaze`, sandbox, `readiness` ou `capacityManager` — confirmado por leitura direta e pelos testes estruturais já existentes, que continuam passando sem alteração.

## 13) Commit

Aguardando push nesta mensagem — hash reportado a seguir.
