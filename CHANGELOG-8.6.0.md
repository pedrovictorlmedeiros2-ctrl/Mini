# v8.6.0

> **Nota (pós-lançamento):** o painel do cliente e o painel administrativo
> descritos abaixo foram **removidos** numa revisão posterior desta mesma
> versão, a pedido — a hospedagem voltou a ser 100% via comandos slash do
> bot Discord, sem nenhum painel web. Seção mantida como registro histórico
> do que existiu nesse ponto do projeto.

## Painel do cliente (novo)

Login com **Discord OAuth2** — sem senha, sem cadastro separado. Cada usuário
só vê e gerencia os próprios bots (dono ou colaborador com permissão
explícita), reaproveitando o mesmo `canManageBot()` que os comandos do bot já
usavam.

- Console ao vivo (Server-Sent Events, sem dependência nova)
- Gerenciador de arquivos + mini editor (CodeMirror via CDN, sem build step):
  explorer, abas, syntax highlighting, criar/editar/renomear/apagar
- Variáveis de ambiente (valores sensíveis mascarados na listagem)
- Start / stop / restart com o mesmo processManager de sempre

Independente do painel administrativo existente (`WEB_PANEL_*`, token único
compartilhado) — os dois podem rodar ao mesmo tempo, portas diferentes.

```env
CUSTOMER_PANEL_ENABLED=true
CUSTOMER_PANEL_PORT=3090
DISCORD_CLIENT_SECRET=...   # Discord Developer Portal → OAuth2 → Reset Secret
DISCORD_REDIRECT_URI=https://seu-dominio.com/auth/callback
PANEL_SESSION_SECRET=...    # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Segurança — achados corrigidos nesta versão

Auditoria + pentest de laboratório (nunca contra o `hosting.db`/`.env` reais)
encontraram e corrigiram:

- **Path traversal via link simbólico** em `fileManager.js` e
  `security_wrapper.js`: a checagem antiga só olhava a string do caminho
  resolvido (`path.resolve` não segue symlink). Um bot podia plantar um link
  dentro da própria pasta apontando pra fora e ler/escrever através dele.
  Corrigido com resolução real de symlink (`fs.realpathSync`) nos dois
  lugares. Confirmado bloqueado inclusive contra o **`.env` real da
  plataforma** (rodando o bot malicioso de verdade pelo `processManager.js`).
- **Rede compartilhada entre containers de bots diferentes**
  (`containerManager.js`): todos usavam a rede "bridge" padrão do Docker,
  então o container de um cliente conseguia alcançar o de outro diretamente
  pela rede. Corrigido com uma rede dedicada
  (`com.docker.network.bridge.enable_icc=false`) + `--cap-drop ALL`.
- **Oráculo de existência de arquivo** introduzido durante o próprio
  desenvolvimento do painel novo (checagem de tamanho de arquivo fazia
  `fs.statSync` sem passar pela validação seguro) — pego e corrigido antes
  de ir pra produção, com teste de regressão.
- Comparação de token do painel admin trocada pra `crypto.timingSafeEqual`.
- `adm-zip` atualizado (`0.5.14` → `0.6.0`): CVE de alta severidade
  (alocação de 4GB de memória com um ZIP malicioso).
- Removido `src/web/webPanel.js` + `dashboard.html`: painel antigo, código
  morto (nada mais chamava), com XSS armazenado real (nome do bot sem
  escape) e o mesmo vazamento de token via `?token=` que já tinha sido
  corrigido no painel atual.

Tudo com teste de regressão automatizado — suíte foi de 24 para 64 testes.
Ver `README.md` → Segurança para o resultado completo do pentest.
