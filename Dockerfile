FROM node:22-alpine

WORKDIR /app

# CORREÇÃO: a imagem só tinha 'curl' (usado pelo HEALTHCHECK), mas duas
# features do próprio sistema dependem de binários que faltavam aqui:
# - git: usado por githubManager.js para clonar/atualizar bots via GitHub
#   (Adicionar Bot via GitHub, Atualizar, Trocar Branch, Rollback).
# - python3 + pip: usados por processManager.js/dependencyManager.js para
#   rodar bots Python e instalar requirements.txt.
# Sem isso, quem rodasse via Docker teria essas duas features quebradas
# silenciosamente (comando não encontrado) mesmo com tudo "funcionando".
RUN apk add --no-cache curl git python3 py3-pip

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

RUN mkdir -p /app/bots /app/backups /app/logs

ENV NODE_ENV=production
ENV HEALTH_PORT=3001
EXPOSE 3000 3001 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3001/health || exit 1

CMD ["node", "index.js"]
