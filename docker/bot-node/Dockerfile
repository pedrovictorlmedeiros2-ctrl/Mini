# Imagem base para bots Node.js hospedados
# Pré-instala runtimes comuns para acelerar cold start
FROM node:22-alpine
RUN apk add --no-cache git python3 make g++ \
 && npm install -g npm@latest \
 && mkdir -p /app
WORKDIR /app
# Dependências frequentes em bots Discord (cache de camada)
RUN npm init -y \
 && npm install --omit=dev discord.js@14 dotenv@16 \
 && rm -rf /app/node_modules /app/package*.json
ENV NODE_ENV=production
USER node
CMD ["node", "index.js"]
