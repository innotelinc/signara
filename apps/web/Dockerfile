# syntax=docker/dockerfile:1

# ---- deps ----------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY apps/web/package.json package.json
COPY package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# ---- build ---------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @signara/web

# ---- runner (standalone output) ------------------------------------------
FROM node:22-alpine AS runner
RUN apk add --no-cache libc6-compat && addgroup -S signara && adduser -S signara -G signara
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder --chown=signara:signara /app/apps/web/.next/standalone ./
COPY --from=builder --chown=signara:signara /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=signara:signara /app/apps/web/public ./apps/web/public
USER signara
EXPOSE 3000
CMD ["node", "apps/web/server.js"]