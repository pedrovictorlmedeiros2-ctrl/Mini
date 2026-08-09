# 🤖 Atlantic Host — v8.5.2 Enterprise

Sistema completo de hospedagem e gestão de bots Discord, com painel interativo, segurança, backup, monitoramento e deploy automatizado.

> Veja `IMPROVEMENTS.md` para o changelog detalhado desta versão.

---

## ✨ O que o projeto oferece

- Painel de hospedagem via Discord com comandos slash e UI completa.
- Gestão de bots e **Site/App**: start / stop / restart / logs / stats / arquivos / env / backup.
- Proteção de RAM do host (limites por plano + teto global).
- Watchdog com aviso antes de matar + DM ao dono.
- Deploy via Token, ZIP ou GitHub (+ Quick Deploy em thread privada).
- Isolamento de dependências Python com **virtualenv por bot**.
- Limites efetivos de CPU/RAM (override por bot + plano + default).
- Criptografia AES-256-GCM de tokens e backups.
- Watchdog, crash-loop protection, auto-restart inteligente.
- Fila de tarefas com concorrência e prioridade.
- Manutenção automática (logs, histórico, VACUUM).
- Docker + PM2 prontos para produção.

---

## 🚀 Instalação rápida

### Pré-requisitos

- Node.js 22 ou 24 (o banco de dados usa o módulo nativo `node:sqlite`, que não existe no Node 20 ou anterior)
- npm
- Git

### Passos

```bash
cd atlantic-host
npm install
cp .env.example .env
```

Edite o arquivo `.env` com valores reais.

### Rodar localmente

```bash
node index.js
```

### Rodar testes

```bash
npm test              # roda toda a suíte (crypto, database, audit)
npm run test:database
npm run test:crypto
npm run test:audit
```

### Migrar tokens antigos

```bash
npm run migrate:tokens
```

---

## ⚙️ Variáveis de ambiente

O arquivo `.env` deve conter, no mínimo:

```env
BOT_TOKEN=seu_token_do_discord
CLIENT_ID=seu_client_id
OWNER_ID=seu_id_discord
ENCRYPTION_KEY=chave_segura_com_32_mais_caracteres
```

Outras opções úteis:

```env
GUILD_ID=seu_servidor_opcional
WEBHOOK_PORT=3000
GITHUB_WEBHOOK_SECRET=segredo_do_webhook
```

---

## 🐳 Docker

### Build e execução

```bash
docker compose up --build -d
```

O projeto já está preparado para montar os diretórios de bots, backups e logs.

---

## 📁 Estrutura principal

```text
atlantic-host/
├── index.js
├── config.js
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── src/
│   ├── commands/
│   ├── database/
│   ├── handlers/
│   ├── managers/
│   └── utils/
└── tests/
```

---

## 🔒 Segurança

- Tokens armazenados com criptografia forte.
- Ambiente de execução isolado por pasta do bot.
- Logs e status de saúde para observabilidade.
- Estrutura preparada para operação profissional.

---

## ✅ Status atual

O projeto está com:

- Banco funcionando
- Criptografia validada
- Migração de tokens executando
- Painel e diagnóstico preparados
- Estrutura Docker pronta para uso em host compatível

---

## 📄 Licença

MIT
