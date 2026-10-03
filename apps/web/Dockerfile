# syntax=docker/dockerfile:1

# ---- deps ----------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --include=dev --no-audit --no-fund

# ---- build ---------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* is inlined into the client bundle at build time, so a build
# that cannot name the deployment's real URLs ships a bundle whose sign-in
# link and API calls point at the browser's own machine. That looks like a
# working deploy and only fails in the browser, so it is made impossible
# here: both URLs are required, and a loopback URL is refused unless the
# build explicitly opts in (only the dev compose file does).
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WEB_URL
ARG NEXT_PUBLIC_ALLOW_LOOPBACK=false
RUN set -eu; \
    if [ -z "$NEXT_PUBLIC_API_URL" ] || [ -z "$NEXT_PUBLIC_WEB_URL" ]; then \
      echo "error: NEXT_PUBLIC_API_URL and NEXT_PUBLIC_WEB_URL are required build args" >&2; \
      echo "       (NEXT_PUBLIC_* is inlined into the client bundle at build time)" >&2; \
      exit 1; \
    fi; \
    if [ "$NEXT_PUBLIC_ALLOW_LOOPBACK" != "true" ]; then \
      case "$NEXT_PUBLIC_API_URL $NEXT_PUBLIC_WEB_URL" in \
        *://localhost*|*://127.0.0.1*) \
          echo "error: refusing to bake a loopback URL into the web bundle" >&2; \
          echo "       NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL" >&2; \
          echo "       NEXT_PUBLIC_WEB_URL=$NEXT_PUBLIC_WEB_URL" >&2; \
          echo "       Point them at the deployment's public URLs, or pass" >&2; \
          echo "       --build-arg NEXT_PUBLIC_ALLOW_LOOPBACK=true for local development." >&2; \
          exit 1; \
          ;; \
      esac; \
    fi
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_PUBLIC_WEB_URL=$NEXT_PUBLIC_WEB_URL
RUN npm run build -w @signara/web

# A bundle that still names a loopback origin is the v0.1.2 login defect: the
# browser resolves it to the reader's own machine, so sign-in and every API
# call fail in the field while the container looks perfectly healthy. The
# build-arg check above stops that arriving through NEXT_PUBLIC_*; this scan
# catches a loopback value hard-coded in source instead. Scan only what the
# runner copies (standalone + static): webpack's .next/cache holds the same
# strings during a build but never ships. Skipped only for the dev build that
# opted in, where loopback is the point.
RUN set -eu; \
    if [ "$NEXT_PUBLIC_ALLOW_LOOPBACK" != "true" ]; then \
      offenders="$(grep -rIlE '//(localhost|127\.0\.0\.1):[0-9]+' \
        /app/apps/web/.next/standalone /app/apps/web/.next/static 2>/dev/null || true)"; \
      if [ -n "$offenders" ]; then \
        echo "error: built web bundle references a loopback URL" >&2; \
        printf '%s\n' "$offenders" >&2; \
        exit 1; \
      fi; \
    fi

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
