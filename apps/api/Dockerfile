# syntax=docker/dockerfile:1

# ---- base ----------------------------------------------------------------
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production

# ---- deps ----------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --include=dev --no-audit --no-fund

# ---- build ---------------------------------------------------------------
FROM deps AS build
COPY . .
RUN npx prisma generate --schema packages/database/prisma/schema.prisma
RUN npm run build -w @signara/api
RUN npm prune --omit=dev

# ---- runtime -------------------------------------------------------------
FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat openssl dumb-init && addgroup -S signara && adduser -S signara -G signara
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=signara:signara /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=signara:signara /app/node_modules ./node_modules
COPY --from=build --chown=signara:signara /app/package.json ./
COPY --from=build --chown=signara:signara /app/packages/database/package.json ./packages/database/package.json
COPY --from=build --chown=signara:signara /app/packages/database/prisma ./packages/database/prisma
USER signara
EXPOSE 8000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
