FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --include=dev: o Coolify pode repassar NODE_ENV=production para o build, e aí o npm
# pularia as devDependencies (tsc incluído).
RUN npm ci --include=dev --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# curl é usado pelo healthcheck (do Docker e do Coolify).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/storage && chown -R node:node /app/storage
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-3000}/health" || exit 1
CMD ["sh", "-c", "node dist/scripts/migrate.js && node dist/scripts/seed-admin.js && node dist/src/server.js"]
