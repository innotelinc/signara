#!/usr/bin/env bash
# ==========================================================================
# Signara — one-shot provisioner
#
#   * validates prerequisites (docker, compose, python3, node)
#   * copies .env templates and generates strong secrets
#   * starts the development stack
#   * applies database migrations + seeds
#   * (optional) provisions NGINX Proxy Manager hosts & wildcard cert
#   * prints the service inventory
#
# Usage: ./setup.sh [--with-nginx]
# ==========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

WITH_NGINX=0
if [[ "${1:-}" == "--with-nginx" ]]; then
  WITH_NGINX=1
fi

log()  { printf '\033[1;36m[signara]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[signara][warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[signara][error]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Prerequisites -------------------------------------------------------
log "Checking prerequisites..."
command -v docker >/dev/null 2>&1 || fail "docker is required (https://docs.docker.com/get-docker/)"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 plugin is required"
command -v python3 >/dev/null 2>&1 || warn "python3 not found — NGINX automation will be skipped"
command -v node >/dev/null 2>&1 || fail "node.js >= 20 is required"
command -v npm  >/dev/null 2>&1 || fail "npm is required"

# --- 2. Environment ---------------------------------------------------------
if [[ ! -f .env ]]; then
  log "Generating .env with strong secrets..."
  cp .env.example .env
  gen() { head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c "$1"; }
  sed -i "s/change-me-postgres/$(gen 24)/g"                 .env
  sed -i "s/change-me-redis/$(gen 24)/g"                     .env
  sed -i "s/change-me-minio/$(gen 24)/g"                     .env
  sed -i "s/change-me-meilisearch/$(gen 24)/g"               .env
  sed -i "s/change-me-oidc-client-secret/$(gen 48)/g"        .env
  sed -i "s/change-me-jwt-access-secret/$(gen 48)/g"         .env
  sed -i "s/change-me-jwt-refresh-secret/$(gen 48)/g"        .env
  sed -i "s/change-me-32-byte-master-key-0000000000/$(gen 32)/g" .env
else
  log ".env already present — leaving it untouched."
fi

# --- 3. Database ------------------------------------------------------------
log "Starting infrastructure services..."
docker compose -f docker-compose.dev.yml up -d postgres redis minio meilisearch

log "Waiting for PostgreSQL..."
until docker compose -f docker-compose.dev.yml exec -T postgres pg_isready -U signara >/dev/null 2>&1; do sleep 2; done

log "Applying database migrations..."
npm install --no-audit --no-fund >/dev/null 2>&1 || true
npm run db:generate
npm run db:migrate

if [[ -n "${SIGNARA_SEED:-}" ]]; then
  log "Seeding database..."
  npm run db:seed
fi

# --- 4. Full stack ----------------------------------------------------------
log "Building and starting the full stack..."
docker compose -f docker-compose.dev.yml up -d --build

# --- 5. NGINX Proxy Manager (optional) -------------------------------------
if [[ "$WITH_NGINX" -eq 1 ]]; then
  if command -v python3 >/dev/null 2>&1; then
    log "Configuring NGINX Proxy Manager (proxy hosts + wildcard cert)..."
    python3 infra/nginx/npm-proxy-hosts.py --apply
  else
    warn "--with-nginx requested but python3 is missing; skipping."
  fi
else
  log "Skipping NGINX provisioning (pass --with-nginx to enable)."
  log "  -> python3 infra/nginx/npm-proxy-hosts.py --apply"
fi

# --- 6. Inventory -----------------------------------------------------------
log "Done. Services:"
log "  Web UI     https://app.signara.innotel.us      (dev: http://localhost:3000)"
log "  API        https://api.signara.innotel.us      (dev: http://localhost:8000)"
log "  Docs       https://docs.signara.innotel.us"
log "  MinIO      http://localhost:9001   (console)"
log "  Meilisearch http://localhost:7700"
log "  Grafana    http://localhost:3001   (admin / from .env)"
log "  Prometheus http://localhost:9090"
log ""
log "Next steps:"
log "  1. Point auth.signara.innotel.us at Authentik and finish the OIDC provider setup"
log "     (see docs/Deployment.md § Identity Provider)."
log "  2. Fill remaining values in .env (SMTP, Stripe, backup)."
log "  3. Run \`make k8s:apply\` to deploy to a Kubernetes cluster (see docs/Deployment.md)."