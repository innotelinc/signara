#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MODE=development
WITH_NGINX=0
WITH_CERULEAN=0
USE_IMAGES=0
IMAGE_TAG_OVERRIDE=""
for arg in "$@"; do
  case "$arg" in
    --production|prod) MODE=production ;;
    --development|dev) MODE=development ;;
    --with-nginx) WITH_NGINX=1 ;;
    --with-cerulean) WITH_CERULEAN=1 ;;
    --use-images) USE_IMAGES=1 ;;
    --image-tag=*) IMAGE_TAG_OVERRIDE="${arg#*=}" ;;
    --image-tag) echo "Usage: ./setup.sh [--development|--production] [--use-images] [--image-tag=TAG] [--with-nginx] [--with-cerulean]" >&2; exit 2 ;;
    *) echo "Usage: ./setup.sh [--development|--production] [--use-images] [--image-tag=TAG] [--with-nginx] [--with-cerulean]" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m[signara]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[signara][warn]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[signara][error]\033[0m %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker is required"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

# Enable the version-controlled commit-guard hooks (.githooks) if this is a
# git checkout (blocks attribution to anyone but Darnel Hunter).
if [ -d "$SCRIPT_DIR/.githooks" ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git config core.hooksPath "$SCRIPT_DIR/.githooks"
  log "commit guard hook enabled (core.hooksPath -> .githooks)"
fi

set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}

gen_hex() { od -An -N "$1" -tx1 /dev/urandom | tr -d ' \n'; }

if [[ ! -f .env ]]; then
  log "Generating .env with strong secrets..."
  cp .env.example .env
  set_env POSTGRES_PASSWORD "$(gen_hex 24)"
  set_env REDIS_PASSWORD "$(gen_hex 24)"
  set_env S3_ACCESS_KEY "signara"
  set_env S3_SECRET_KEY "$(gen_hex 24)"
  set_env MEILISEARCH_API_KEY "$(gen_hex 24)"
  set_env OIDC_CLIENT_SECRET "$(gen_hex 36)"
  set_env JWT_ACCESS_SECRET "$(gen_hex 36)"
  set_env JWT_REFRESH_SECRET "$(gen_hex 36)"
  set_env CRYPTO_MASTER_KEY "$(gen_hex 32)"
  set_env AUTHENTIK_SECRET_KEY "$(gen_hex 48)"
  set_env AUTHENTIK_DB_PASSWORD "$(gen_hex 24)"
  set_env AUTHENTIK_BOOTSTRAP_PASSWORD "$(gen_hex 24)"
  set_env GRAFANA_ADMIN_PASSWORD "$(gen_hex 24)"
  set_env BACKUP_INTERVAL_SECONDS 86400
  set_env BACKUP_RUN_ON_START true
  set_env BACKUP_REQUIRE_REMOTE false
  chmod 600 .env
else
  log ".env already present; leaving existing values unchanged."
fi

set_env_if_equals() {
  local key="$1" old_value="$2" new_value="$3"
  local current
  current="$(grep -E "^${key}=" .env | tail -1 | cut -d= -f2- || true)"
  if [[ "$current" == "$old_value" ]]; then
    set_env "$key" "$new_value"
  fi
}

# Mode-specific security and endpoint values are enforced without overwriting
# operator-owned custom URLs in an existing .env.
if [[ "$MODE" == production ]]; then
  set_env NODE_ENV production
  set_env SESSION_COOKIE_SECURE true
  set_env_if_equals APP_URL http://localhost:3000 https://app.signara.innotel.us
  set_env_if_equals API_URL http://localhost:8000 https://api.signara.innotel.us
  set_env_if_equals WEB_URL http://localhost:3000 https://app.signara.innotel.us
  set_env_if_equals AUTH_URL http://localhost:9100 https://auth.signara.innotel.us
  set_env_if_equals OIDC_ISSUER_URL http://localhost:9100/application/o/signara/ https://auth.signara.innotel.us/application/o/signara/
  set_env_if_equals OIDC_JWKS_URL http://localhost:9100/application/o/signara/jwks/ http://authentik-server:9000/application/o/signara/jwks/
  set_env_if_equals OIDC_REDIRECT_URI http://localhost:8000/api/v1/auth/callback https://api.signara.innotel.us/api/v1/auth/callback
  set_env_if_equals OIDC_AUTHORIZATION_URL http://localhost:9100/application/o/authorize/ https://auth.signara.innotel.us/application/o/authorize/
  set_env_if_equals OIDC_TOKEN_URL http://localhost:9100/application/o/token/ http://authentik-server:9000/application/o/token/
  set_env_if_equals OIDC_USERINFO_URL http://localhost:9100/application/o/userinfo/ http://authentik-server:9000/application/o/userinfo/
  set_env_if_equals CSP_REPORT_URI http://localhost:8000/api/v1/audit/csp-report https://api.signara.innotel.us/api/v1/audit/csp-report
else
  set_env NODE_ENV development
  set_env SESSION_COOKIE_SECURE false
  set_env_if_equals APP_URL https://app.signara.innotel.us http://localhost:3000
  set_env_if_equals API_URL https://api.signara.innotel.us http://localhost:8000
  set_env_if_equals WEB_URL https://app.signara.innotel.us http://localhost:3000
  set_env_if_equals AUTH_URL https://auth.signara.innotel.us http://localhost:9100
  set_env_if_equals OIDC_ISSUER_URL https://auth.signara.innotel.us/application/o/signara/ http://localhost:9100/application/o/signara/
  set_env_if_equals OIDC_JWKS_URL http://authentik-server:9000/application/o/signara/jwks/ http://localhost:9100/application/o/signara/jwks/
  set_env_if_equals OIDC_REDIRECT_URI https://api.signara.innotel.us/api/v1/auth/callback http://localhost:8000/api/v1/auth/callback
  set_env_if_equals OIDC_AUTHORIZATION_URL https://auth.signara.innotel.us/application/o/authorize/ http://localhost:9100/application/o/authorize/
  set_env_if_equals OIDC_TOKEN_URL http://authentik-server:9000/application/o/token/ http://authentik-server:9000/application/o/token/
  set_env_if_equals OIDC_USERINFO_URL http://authentik-server:9000/application/o/userinfo/ http://authentik-server:9000/application/o/userinfo/
  set_env_if_equals CSP_REPORT_URI https://api.signara.innotel.us/api/v1/audit/csp-report http://localhost:8000/api/v1/audit/csp-report
fi

if [[ -n "$IMAGE_TAG_OVERRIDE" ]]; then
  [[ "$IMAGE_TAG_OVERRIDE" =~ ^[A-Za-z0-9._-]+$ ]] || fail "image tag contains unsupported characters"
  set_env IMAGE_TAG "$IMAGE_TAG_OVERRIDE"
  image_prefix="${SIGNARA_IMAGE_PREFIX:-ghcr.io/innotelinc/signara}"
  set_env SIGNARA_API_IMAGE "${image_prefix}-api:${IMAGE_TAG_OVERRIDE}"
  set_env SIGNARA_WEB_IMAGE "${image_prefix}-web:${IMAGE_TAG_OVERRIDE}"
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

if [[ "$MODE" == production ]]; then
  required=(POSTGRES_PASSWORD REDIS_PASSWORD S3_SECRET_KEY MEILISEARCH_API_KEY OIDC_CLIENT_SECRET JWT_ACCESS_SECRET JWT_REFRESH_SECRET CRYPTO_MASTER_KEY AUTHENTIK_SECRET_KEY AUTHENTIK_DB_PASSWORD AUTHENTIK_BOOTSTRAP_PASSWORD GRAFANA_ADMIN_PASSWORD)
  for key in "${required[@]}"; do
    value="${!key:-}"
    [[ -n "$value" && "$value" != change-me* ]] || fail "$key must be set to a non-default value for production"
  done
  [[ "${SESSION_COOKIE_SECURE:-false}" == true ]] || fail "SESSION_COOKIE_SECURE=true is required for production"
  for key in APP_URL API_URL WEB_URL AUTH_URL OIDC_ISSUER_URL OIDC_REDIRECT_URI; do
    value="${!key:-}"
    [[ "$value" == https://* ]] || fail "$key must use an https:// URL for production"
  done

  log "Starting production application dependencies..."
  docker compose -f docker-compose.prod.yml up -d postgres redis minio meilisearch
  if [[ "${AUTHENTIK_MODE:-remote}" == local ]]; then
    log "Starting the optional local Authentik replacement..."
    docker compose -f docker-compose.prod.yml --profile authentik up -d authentik-db authentik-redis authentik-server authentik-worker
  fi
  if (( USE_IMAGES )); then
    log "Pulling the configured production API and web images..."
    docker compose -f docker-compose.prod.yml pull api frontend migrate
  else
    log "Building production API and web images..."
    docker compose -f docker-compose.prod.yml build api frontend
  fi
  log "Building the local backup image..."
  docker compose -f docker-compose.prod.yml build backup
  log "Applying production migrations..."
  docker compose -f docker-compose.prod.yml run --rm migrate
  log "Starting the production stack..."
  docker compose -f docker-compose.prod.yml up -d --remove-orphans
else
  if [[ "${WEB_URL:-}" != http://localhost:3000 ]]; then
    warn "WEB_URL is ${WEB_URL:-unset}; local browser requests require WEB_URL=http://localhost:3000"
  fi
  log "Starting development application dependencies..."
  docker compose -f docker-compose.dev.yml up -d postgres redis minio meilisearch
  if [[ "${AUTHENTIK_MODE:-remote}" == local ]]; then
    log "Starting the optional local Authentik replacement..."
    docker compose -f docker-compose.dev.yml --profile authentik up -d authentik-db authentik-redis authentik-server authentik-worker
  fi
  log "Applying development migrations in the Compose network..."
  docker compose -f docker-compose.dev.yml run --rm --build migrate
  log "Building and starting the development stack..."
  docker compose -f docker-compose.dev.yml up -d --build
fi

if (( WITH_NGINX )); then
  command -v python3 >/dev/null 2>&1 || fail "python3 is required for --with-nginx"
  log "Configuring NGINX Proxy Manager..."
  python3 infra/nginx/npm-proxy-hosts.py --apply
fi

if (( WITH_CERULEAN )) || [[ "${CERULEAN_AUTO_PROVISION:-false}" == "true" ]]; then
  command -v python3 >/dev/null 2>&1 || fail "python3 is required for Cerulean provisioning"
  [[ -n "${CERULEAN_ADMIN_PASSWORD:-}" ]] || fail "CERULEAN_ADMIN_PASSWORD is required for Cerulean provisioning"
  [[ -n "${CERULEAN_LAN_IP:-}" ]] || warn "CERULEAN_LAN_IP is unset; provisioning will detect a non-virtual host LAN address"
  [[ -n "${CERULEAN_WAN_IP:-}" ]] || log "CERULEAN_WAN_IP is unset; provisioning will detect and persist the public WAN address"
  log "Provisioning Signara DNS, NGINX Proxy Manager hosts, and TLS through Cerulean..."
  python3 infra/cerulean/provision.py --dotenv .env
fi

log "Signara $MODE setup complete"
if [[ "$MODE" == development ]]; then
  log "  Web UI     http://localhost:3000"
  log "  API        http://localhost:8000"
  log "  Authentik  http://localhost:9100"
else
  log "  Web UI     ${WEB_URL:-https://app.signara.innotel.us}"
  log "  API        ${API_URL:-https://api.signara.innotel.us}"
fi
log "  Review docs/Deployment.md for Compose operations, TLS, backups, and Authentik."

# ── Infisical (SecretOps) — opt-in secret provisioning ──────────────
# Secrets for the Innotel Platform Stack live in Infisical. Enable by
# setting INFISICAL_ADMIN_EMAIL / INFISICAL_ADMIN_PASSWORD and the
# INFISICAL_* keys in .env, then re-run setup (idempotent).
if grep -qE '^INFISICAL_ADMIN_EMAIL=.+' .env 2>/dev/null && \
   grep -qE '^INFISICAL_ADMIN_PASSWORD=.+' .env 2>/dev/null; then
  __root="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
  case "$__root" in
    */scripts) __root="$(dirname "$__root")" ;;
  esac
  if [ -f "$__root/scripts/infisical-setup.sh" ]; then
    echo ">> provisioning secrets into Infisical (SecretOps)..."
    bash "$__root/scripts/infisical-setup.sh" \
      || echo "!! infisical setup failed (see above); .env values remain valid" >&2
  fi
  unset __root
fi
