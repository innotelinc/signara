#!/usr/bin/env bash
# provision-edge.sh — make Signara reachable publicly through the NPM edge.
#   1. DNS: CNAMEs (app/api.signara.<base> -> innotel.us apex) via TSIG nsupdate.
#   2. NPM proxy hosts: https://app.signara.<base> -> http://192.168.1.46:3000
#      https://api.signara.<base> -> http://192.168.1.46:8000, and
#      https://storage.signara.<base> -> http://192.168.1.46:2090 (the
#      onyx-objectstore that now holds documents — docs/Roadmap.md W3), each
#      with a single-name Let's Encrypt cert (HTTP-01; NPM wildcard issuance is
#      broken).
#
# Re-running updates existing hosts in place. It deliberately preserves an
# existing host's certificate rather than re-issuing one: storage.signara uses a
# custom cert, and a forced re-issue would silently swap it for a Let's Encrypt
# one.
set -euo pipefail
CERULEAN_ENV="${CERULEAN_ENV:-/usr/src/projects/complete/1-primary/cerulean/.env}"

# Read the few Cerulean keys this needs instead of `source`-ing the file.
# .env is not shell syntax, and sourcing it executes what is in it: a value with
# a space in it runs its second word as a command — cerulean's
# VAULT_PRODUCT_TOKENS does exactly that today — and a hostile .env would run
# anything at all. Values are taken literally, up to the first `=`.
env_key() {
  local line
  line=$(grep -m1 "^$1=" "$CERULEAN_ENV" 2>/dev/null || true)
  printf '%s' "${line#*=}"
}
NPM_API_URL="$(env_key NPM_API_URL)"
NPM_EMAIL="$(env_key NPM_EMAIL)"
NPM_PASSWORD="$(env_key NPM_PASSWORD)"
BIND_TSIG_SECRET="$(env_key BIND_TSIG_SECRET)"

BIND_SERVER="${BIND_SERVER:-192.168.1.80}"
BIND_TSIG_NAME="${BIND_TSIG_NAME:-cerulean}"
FORWARD_HOST="${FORWARD_HOST:-192.168.1.46}"
BASE_DOMAIN="${BASE_DOMAIN:-innotel.us}"
NPM_API_URL="${NPM_API_URL:-http://192.168.1.46:81}"
ACME_EMAIL="${ACME_EMAIL:-admin@innotel.us}"
DOMAINS=(app.signara.${BASE_DOMAIN} api.signara.${BASE_DOMAIN} storage.signara.${BASE_DOMAIN})
# Host ports come from the environment instead of being assumed. The API is
# published on API_BIND_PORT (8002 in this estate), and this script previously
# hard-coded 8000 — which would have silently repointed a working route at
# nothing. The object store is published by the onyx-platform stack.
APP_PORT="${APP_PORT:-3000}"
API_PORT="${API_PORT:-${API_BIND_PORT:-8002}}"
OBJECTSTORE_PORT="${OBJECTSTORE_PORT:-2090}"

echo "== 1/2 DNS CNAMEs (TSIG nsupdate -> $BIND_SERVER) =="
if [ -n "${BIND_TSIG_SECRET:-}" ]; then
  keyfile=$(mktemp); chmod 600 "$keyfile"
  printf 'key "%s" { algorithm hmac-sha256; secret "%s"; };\n' "$BIND_TSIG_NAME" "$BIND_TSIG_SECRET" > "$keyfile"
  if { echo "server $BIND_SERVER"; echo "zone ${BASE_DOMAIN}.";
       for d in "${DOMAINS[@]}"; do
         echo "update delete ${d}. CNAME"
         echo "update add ${d}. 300 CNAME ${BASE_DOMAIN}."
       done
       echo send; } | nsupdate -k "$keyfile"; then
    echo "   DNS records set: ${DOMAINS[*]} -> ${BASE_DOMAIN}"
  else
    # Not fatal. The records are normally already correct, and a nameserver
    # that is down must not stop the edge from being updated — which is exactly
    # what used to happen: nsupdate failing here aborted before any proxy host
    # was touched.
    echo "   nsupdate failed (is $BIND_SERVER reachable?) — leaving DNS as it is"
    echo "   check by hand: ${DOMAINS[*]} should resolve to ${BASE_DOMAIN}"
  fi
  rm -f "$keyfile"
else
  echo "   BIND_TSIG_SECRET unset — skipping DNS"
fi

echo "== 2/2 NPM proxy hosts + LE certs =="
NPM_API_URL="$NPM_API_URL" NPM_EMAIL="$NPM_EMAIL" NPM_PASSWORD="$NPM_PASSWORD" \
ACME_EMAIL="$ACME_EMAIL" FORWARD_HOST="$FORWARD_HOST" BASE_DOMAIN="$BASE_DOMAIN" \
APP_PORT="$APP_PORT" API_PORT="$API_PORT" OBJECTSTORE_PORT="$OBJECTSTORE_PORT" \
python3 - <<'PY'
import json, os, urllib.request, urllib.error
api = os.environ["NPM_API_URL"].rstrip("/")
def req(method, path, body=None):
    r = urllib.request.Request(api + path, method=method,
        data=json.dumps(body).encode() if body is not None else None)
    r.add_header("Content-Type", "application/json")
    if getattr(req, "token", None):
        r.add_header("Authorization", "Bearer " + req.token)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f"NPM {method} {path} -> HTTP {e.code}: {e.read().decode()[:300]}")
tok = req("POST", "/api/tokens", {"identity": os.environ["NPM_EMAIL"], "secret": os.environ["NPM_PASSWORD"]})
req.token = tok["token"]
hosts = req("GET", "/api/nginx/proxy-hosts") or []
by_domain = {h["domain_names"][0]: h for h in hosts}
base = os.environ["BASE_DOMAIN"]
le_meta = {"letsencrypt_agree": True, "dns_challenge": False,
           "letsencrypt_email": os.environ["ACME_EMAIL"], "letsencrypt_force": True,
           "hsts": False, "hsts_subdomains": False}
plan = [
    (f"app.signara.{base}", int(os.environ["APP_PORT"]), True,  le_meta),
    (f"api.signara.{base}", int(os.environ["API_PORT"]), False, le_meta),
    # Documents are fetched straight from the store with presigned URLs, so this
    # route is what makes a browser-facing download work at all.
    (f"storage.signara.{base}", int(os.environ["OBJECTSTORE_PORT"]), False, le_meta),
]
for domain, port, ws, meta in plan:
    payload = {"domain_names": [domain], "forward_scheme": "http",
               "forward_host": os.environ["FORWARD_HOST"], "forward_port": port,
               "certificate_id": "new", "ssl_forced": True, "http2_support": True,
               "block_exploits": True, "caching_enabled": False,
               "allow_websocket_upgrade": ws, "access_list_id": 0,
               "advanced_config": "", "locations": [], "meta": meta, "enabled": True}
    existing = by_domain.get(domain)
    if existing:
        # No `id` in the body: the API takes it from the path and rejects it as
        # an unexpected property. That rejection is why this update branch had
        # never actually run — which is how a hard-coded API port of 8000 went
        # unnoticed while the deployed API answers on 8002.
        # Keep the certificate it already has. `certificate_id: "new"` above is
        # right for a host being created and wrong for one being updated: with
        # letsencrypt_force it re-issues, which would replace storage.signara's
        # custom certificate and any advanced_config the host carries.
        payload["certificate_id"] = existing.get("certificate_id", "new")
        payload["advanced_config"] = existing.get("advanced_config", "")
        req("PUT", f"/api/nginx/proxy-hosts/{existing['id']}", payload)
        print(f"   updated {domain} (host {existing['id']}, cert preserved)")
    else:
        out = req("POST", "/api/nginx/proxy-hosts", payload)
        print(f"   created {domain} (host {out['id']})")
PY

echo "== verify =="
for d in "${DOMAINS[@]}"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://${d}/" || true)
  echo "   https://${d} -> ${code}"
done
