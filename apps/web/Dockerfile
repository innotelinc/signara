# syntax=docker/dockerfile:1

# ---- deps ----------------------------------------------------------------
FROM node:26-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --include=dev --no-audit --no-fund

# ---- build ---------------------------------------------------------------
FROM node:26-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ARG NEXT_PUBLIC_WEB_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_WEB_URL=$NEXT_PUBLIC_WEB_URL
RUN npm run build -w @signara/web

# ---- runner (standalone output) ------------------------------------------
FROM node:26-alpine AS runner
RUN apk add --no-cache libc6-compat && addgroup -S signara && adduser -S signara -G signara
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=builder --chown=signara:signara /app/apps/web/.next/standalone ./
COPY --from=builder --chown=signara:signara /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=signara:signara /app/apps/web/public ./apps/web/public
USER signara
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
