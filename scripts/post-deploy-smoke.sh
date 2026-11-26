#!/usr/bin/env bash
# post-deploy-smoke.sh — the checks that decide whether a deploy actually landed.
#
# A green `docker compose up -d` only says the containers were created. The API
# container can be up while the edge serves 502s, and the web container can be
# "running" while its bundle points at the wrong API host. This walks the path a
# person actually takes — container state, the API's own readiness, the web app,
# and (unless SMOKE_PUBLIC=0) the public hostnames the edge answers for — and
# exits non-zero if any of it is wrong, so a deploy gate can trust the result.
#
# Usage:
#   ./scripts/post-deploy-smoke.sh
#   SMOKE_PUBLIC=0 ./scripts/post-deploy-smoke.sh          # local only
#   API_BASE=http://127.0.0.1:8000 WEB_BASE=http://127.0.0.1:3000 ./scripts/post-deploy-smoke.sh
set -Eeuo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE=(docker compose -f docker-compose.prod.yml)
SMOKE_PUBLIC=${SMOKE_PUBLIC:-1}
SMOKE_WAIT=${SMOKE_WAIT:-60}
PUBLIC_WEB=${PUBLIC_WEB:-https://signara.innotel.us}
PUBLIC_APP=${PUBLIC_APP:-https://app.signara.innotel.us}
PUBLIC_API=${PUBLIC_API:-https://api.signara.innotel.us}

failures=0
ok()  { printf '  ok    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*" >&2; failures=$((failures + 1)); }

# The compose file publishes ${API_BIND_PORT}/${WEB_BIND_PORT}, and this host
# pins the API to 8002 in .env — so the compose *defaults* are not the local
# addresses, and hard-coding 8000 made this check fail against a healthy stack.
# Ask compose what it actually published instead of guessing.
published_port() { # <service> <container-port> <fallback>
  local pub
  pub=$("${COMPOSE[@]}" port "$1" "$2" 2>/dev/null | head -n 1) || pub=""
  pub=${pub##*:}
  printf '%s' "${pub:-$3}"
}
API_BASE=${API_BASE:-http://127.0.0.1:$(published_port api 8000 8000)}
WEB_BASE=${WEB_BASE:-http://127.0.0.1:$(published_port frontend 3000 3000)}

# curl exits 0 on a 502, so the status code is read explicitly; a refused
# connection has no code at all, which is normalised to 000.
http_code() { # <url> -> 3-digit code
  local code
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null) || code=000
  printf '%s' "${code:-000}"
}

# --- 1. containers ---------------------------------------------------------
# Health matters more than "Up": a container whose healthcheck never passes is
# restarting or refusing traffic even though `ps` calls it running.
check_service() { # <service>
  local svc=$1 id state health
  id=$("${COMPOSE[@]}" ps -q "$svc" 2>/dev/null | head -n 1)
  if [ -z "$id" ]; then bad "$svc: no container"; return; fi
  state=$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo unknown)
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id" 2>/dev/null || echo unknown)
  if [ "$state" != running ]; then
    bad "$svc: state=$state"
  elif [ "$health" != none ] && [ "$health" != healthy ]; then
    bad "$svc: state=running health=$health"
  else
    ok "$svc: running health=$health"
  fi
}

for svc in postgres redis meilisearch api frontend; do
  check_service "$svc"
done

# A restart count above zero means the container has already died at least once
# since it was created — the exact thing a deploy that "looked fine" hides.
for svc in api frontend; do
  id=$("${COMPOSE[@]}" ps -q "$svc" 2>/dev/null | head -n 1)
  [ -n "$id" ] || continue
  n=$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null || echo 0)
  if [ "${n:-0}" != 0 ]; then bad "$svc: RestartCount=$n"; else ok "$svc: no restarts"; fi
done

# --- 2. API readiness ------------------------------------------------------
# `migrate` runs before the API on a fresh deploy, so readiness is polled rather
# than sampled once.
deadline=$((SECONDS + SMOKE_WAIT))
api_code=000
while [ "$SECONDS" -lt "$deadline" ]; do
  api_code=$(http_code "$API_BASE/ready")
  [ "$api_code" = 200 ] && break
  sleep 3
done
if [ "$api_code" = 200 ]; then ok "api /ready HTTP 200 ($API_BASE)"; else bad "api /ready HTTP $api_code ($API_BASE)"; fi

# --- 3. web app ------------------------------------------------------------
web_code=$(http_code "$WEB_BASE/")
if [ "$web_code" = 200 ] && curl -sS -m 15 "$WEB_BASE/" 2>/dev/null | grep -qi '<html'; then
  ok "web / HTTP 200 with HTML ($WEB_BASE)"
else
  bad "web / HTTP $web_code without HTML ($WEB_BASE)"
fi

# --- 4. public edge --------------------------------------------------------
# TLS + proxy + the app's own hostnames: the layer a container check cannot see.
if [ "$SMOKE_PUBLIC" = 1 ]; then
  for pair in "web $PUBLIC_WEB/" "app $PUBLIC_APP/" "api $PUBLIC_API/ready"; do
    label=${pair%% *}; url=${pair#* }
    code=$(http_code "$url")
    if [ "$code" = 200 ]; then ok "public $label HTTP 200 ($url)"; else bad "public $label HTTP $code ($url)"; fi
  done
fi

echo
if [ "$failures" -ne 0 ]; then
  echo "smoke: $failures check(s) failed" >&2
  exit 1
fi
echo "smoke: all checks passed"
