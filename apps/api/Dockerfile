# syntax=docker/dockerfile:1

# ---- base ----------------------------------------------------------------
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production

# ---- deps ----------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# ---- build ---------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate Prisma client for the API package
RUN npx prisma generate --schema ../../packages/database/prisma/schema.prisma || true
RUN npm run build

# ---- runtime -------------------------------------------------------------
FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat openssl dumb-init && addgroup -S signara && adduser -S signara -G signara
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=signara:signara /app/dist ./dist
COPY --from=build --chown=signara:signara /app/node_modules ./node_modules
COPY --from=build --chown=signara:signara /app/package.json ./
USER signara
EXPOSE 8000
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]