ATLANTIC HOST
FINAL BUILD REPORT

Versão: 8.6.0 Enterprise
Data: evolução autônoma sobre o codebase real v8.5.2 (opção escolhida pelo
usuário entre reconstrução do zero e evolução do projeto existente).

> **Nota (pós-lançamento):** a pedido, o painel do cliente e o painel
> administrativo descritos neste relatório foram removidos numa revisão
> posterior — a hospedagem voltou a ser só via comandos slash do bot Discord.
> Documento mantido como registro histórico do build original.

---

Arquitetura:

- Frontend: SPA vanilla JS (`src/web/customer-public/index.html`), sem
  build step, CodeMirror 5 via CDN para o mini editor de código com syntax
  highlighting (JS, Python, HTML, CSS, XML, Markdown, YAML, Shell).
- Backend: Node.js + Express (`src/web/customerPanel.js` para o painel do
  cliente, `src/web/panelServer.js` para o painel administrativo), sessão
  própria via cookie HMAC-SHA256 assinado (`src/utils/panelSession.js`),
  sem dependência de JWT ou cookie-parser.
- Bot: Discord.js v14, comandos slash, é o canal principal de venda — o
  site não tem checkout próprio.
- Database: `node:sqlite` (módulo nativo do Node 22+), schema com
  `users`, `bots`, `bot_collaborators`, `orders`, `backups`,
  `env_variables`, `logs`, `action_history`, `plans`, `coupons`, `nodes`.
- Docker: isolamento opcional por container (`USE_CONTAINERS=true`), rede
  dedicada por tenant (`atlantic-host-tenants`,
  `com.docker.network.bridge.enable_icc=false`), `--cap-drop ALL`,
  `--security-opt no-new-privileges`, rootfs `--read-only`, sem exposição
  do socket do Docker. Sem Docker disponível, isolamento por processo via
  `security_wrapper.js`.

---

Funcionalidades:

✓ Login exclusivamente via Discord OAuth2 (sem senha, sem cadastro
  independente, sem Google) — painel do cliente novo.
✓ Cada usuário só vê e gerencia os próprios bots (dono ou colaborador com
  permissão explícita), reaproveitando o mesmo `canManageBot()` dos
  comandos do bot.
✓ Mini editor de código no navegador: explorer de arquivos, abas, syntax
  highlighting, criar/editar/renomear/apagar — nunca acesso direto ao
  filesystem do host, tudo passa por `fileManager.js` com validação de
  caminho.
✓ Gerenciador de arquivos com proteção contra path traversal (`../` e
  escape via link simbólico).
✓ Console em tempo real via Server-Sent Events (sem dependência nova).
✓ Variáveis de ambiente por bot, com mascaramento de valores sensíveis na
  listagem.
✓ Start/stop/restart, logs, stats — mesmo `processManager.js` de sempre.
✓ Painel administrativo (token único) mantido, independente do painel do
  cliente, outra porta.
✓ Bot Discord como canal de venda principal, com deploy via token, ZIP ou
  GitHub.
✓ Isolamento de dependências Python via virtualenv por bot.
✓ Watchdog com proteção de RAM do host, crash-loop protection,
  auto-restart inteligente, aviso + DM ao dono antes de matar processo.
✓ Criptografia AES-256-GCM de tokens e backups.

---

Segurança:

✓ Checkpoint único de autorização em toda rota de bot: quem está pedindo /
  qual recurso / de quem é o recurso / o plano permite / a operação é
  permitida — decidido em `loadBot()`/`canManageBot()`, nunca duplicado
  rota a rota.
✓ Negação de acesso sempre retorna 404, nunca 403 — não confirma a
  existência do recurso pra quem não tem acesso (mitigação de IDOR/
  enumeração).
✓ Sessão HMAC-SHA256 assinada, comparação de token em tempo constante
  (`crypto.timingSafeEqual`), cookie `HttpOnly` + `SameSite=Lax` (+
  `Secure` em produção) — nunca token na URL.
✓ Validação de caminho com resolução real de symlink
  (`fs.realpathSync`) em toda operação de arquivo, tanto no painel quanto
  na sandbox do processo do bot.
✓ Sandbox de processo bloqueia `child_process`, `cluster`, `vm`,
  `inspector`, `process.fork`, `process.binding`, inclusive via `import()`
  dinâmico.
✓ Isolamento de rede entre containers de tenants diferentes, sem exposição
  do socket do Docker.
✓ Rate limiting nas rotas de escrita do painel (arquivos, env vars).
✓ Nenhum segredo real foi copiado para código novo — `DISCORD_CLIENT_SECRET`
  e `PANEL_SESSION_SECRET` só existem como placeholders vazios em
  `.env.example`/`env.template`; valores reais ficam apenas no `.env` local
  (gitignored), nunca commitados.

---

Pentest:

Total: 64 testes automatizados de segurança (`npm run test:ci`)
Bloqueados: 64 (100% dos vetores testados foram barrados pela blindagem existente ou pela correção aplicada)
Corrigidos: 5 vulnerabilidades reais encontradas e corrigidas neste ciclo
  (path traversal via symlink em fileManager.js e security_wrapper.js, rede
  Docker compartilhada entre tenants, oráculo de existência de arquivo
  introduzido durante o próprio desenvolvimento, comparação de token não
  constante no painel admin, XSS armazenado + vazamento de token por query
  string no painel administrativo antigo — removido por ser código morto)
Falhos: 0 (nenhum teste de segurança ficou vermelho na suíte final)

Vetores cobertos: path traversal clássico, path traversal via symlink,
sandbox escape (módulos nativos + import dinâmico), exfiltração do `.env`
real da plataforma, fork bomb/exaustão de recursos, injeção de comando,
IDOR/bypass de autorização (varredura de 14 rotas), bypass de plano, XSS
armazenado, vazamento de token via URL, CVE de dependência (adm-zip),
SSRF/SQL injection (não aplicável — sem chamada de rede controlada por
usuário e sem SQL por concatenação de string).

Fora de escopo, recusado por segurança: malware auto-replicante ou
destrutivo real (mesmo em laboratório isolado) — risco de propagação
acidental. Os vetores acima cobrem os mesmos mecanismos de exploração
(escape de sandbox, exfiltração, exaustão de recursos) sem esse risco.

Ver `README.md` → seção Segurança para o detalhamento vulnerabilidade por
vulnerabilidade (severidade, componente, detecção, impacto, correção,
teste de regressão).

---

Problemas encontrados:

1. Path traversal via link simbólico em `fileManager.js` (gerenciador de
   arquivos do painel) e `security_wrapper.js` (sandbox de processo do
   bot) — a validação antiga só olhava a string do caminho resolvido, que
   não segue symlink.
2. Rede Docker compartilhada (`bridge` padrão) entre containers de
   tenants diferentes — um bot conseguia alcançar o container de outro
   cliente diretamente pela rede.
3. Comparação de token do painel administrativo sem tempo constante
   (`===` normal), suscetível a timing attack teórico.
4. Painel administrativo antigo morto (`webPanel.js`/`dashboard.html`),
   não referenciado em lugar nenhum do código, com XSS armazenado real
   (nome do bot sem escape) e vazamento de token via `?token=` na URL.
5. Oráculo de existência/tamanho de arquivo introduzido durante o próprio
   desenvolvimento do painel do cliente novo (rota de conteúdo de arquivo
   usava `fs.statSync` direto, sem passar pela validação segura) — pego
   antes de ir pra produção.
6. `adm-zip` desatualizado (`0.5.14`), CVE de alta severidade (alocação de
   4GB de memória com ZIP malicioso).
7. Dependência transitiva `uuid` (via `node-cron`) com CVE moderado —
   aceito como risco documentado, não corrigido neste ciclo.

---

Correções:

1. `safeResolve()` em `fileManager.js` e `assertInsideBotDir()` em
   `security_wrapper.js` reescritos para usar `fs.realpathSync()` com
   caminhada até o ancestral existente mais próximo, rejeitando qualquer
   caminho cujo alvo real caia fora da pasta real do bot.
2. `containerManager.js`: rede dedicada `atlantic-host-tenants`
   (`com.docker.network.bridge.enable_icc=false`) criada
   automaticamente, `--cap-drop ALL` adicionado aos argumentos do Docker.
3. `panelAuth.js`: comparação trocada para `crypto.timingSafeEqual` com
   buffers de tamanho igual mesmo em caso de mismatch (não vaza tamanho).
4. `webPanel.js` e `dashboard.html` removidos — confirmado código morto
   via busca em todo o projeto (só `panelServer.js` é usado por
   `index.js`).
5. Nova função `fileManager.statFile()` (usa a mesma validação segura) e
   rota do painel do cliente trocada pra usá-la, com mensagem de erro
   genérica em vez de vazar caminho do host.
6. `adm-zip` atualizado para `^0.6.0`; zip-slip e zip-bomb re-testados
   depois da atualização.
7. Suíte de testes de regressão criada para cada correção acima
   (`tests/fileManager.test.js`, `tests/fileManagerStat.test.js`,
   `tests/securityWrapper.test.js`, `tests/containerManager.test.js`,
   `tests/panelAuth.test.js`, `tests/customerPanel.test.js`).

---

Como executar:

```bash
cd atlantic-host
npm install
cp .env.example .env
# edite o .env com valores reais (veja "Variáveis necessárias" abaixo)
node index.js
```

Painel do cliente (opcional, precisa das variáveis de OAuth2 configuradas):
acesse `http://localhost:3090` (ou o `CUSTOMER_PANEL_PORT` configurado) e
entre com o Discord.

Testes:

```bash
npm test           # suíte inteira
npm run test:ci    # subconjunto sem token real do Discord (usado em CI)
```

---

Variáveis necessárias:

Obrigatórias (bot):
```env
BOT_TOKEN=seu_token_do_discord
CLIENT_ID=seu_client_id
OWNER_ID=seu_id_discord
ENCRYPTION_KEY=chave_segura_com_32_mais_caracteres
```

Opcionais (bot):
```env
GUILD_ID=seu_servidor_opcional
WEBHOOK_PORT=3000
GITHUB_WEBHOOK_SECRET=segredo_do_webhook
```

Painel do cliente (só se `CUSTOMER_PANEL_ENABLED=true`):
```env
CUSTOMER_PANEL_ENABLED=false
CUSTOMER_PANEL_PORT=3090
CUSTOMER_PANEL_HOST=0.0.0.0
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=http://localhost:3090/auth/callback
PANEL_SESSION_SECRET=
```

**Nota sobre segredos:** nenhum token/senha real foi copiado para o código
ou para `.env.example`/`env.template` — só placeholders vazios. Se este
repositório já teve algum segredo real exposto em algum momento (token do
bot, client secret, chave de criptografia), esse valor deve ser
considerado comprometido e **rotacionado** (gerar um novo no Discord
Developer Portal / regenerar a chave) antes de ir para produção.

---

Próximas melhorias:

- Atualizar `node-cron` para uma versão sem a CVE moderada transitiva do
  `uuid`, validando o agendamento de produção antes de trocar (bump
  semver-major).
- Estender o isolamento por container (`USE_CONTAINERS=true`) como padrão
  em produção, com `USE_CONTAINERS=false` (sandbox de processo) reservado
  para ambientes sem Docker disponível.
- Adicionar 2FA opcional no painel administrativo (token único hoje).
- Métricas de uso por bot no painel do cliente (histórico de CPU/RAM, não
  só valor atual).
- Testes de carga/exaustão de recursos mais realistas contra os limites de
  `--pids-limit`/memória em container (os testes atuais validam a
  configuração, não o comportamento sob carga sustentada).
