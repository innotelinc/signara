#!/usr/bin/env bash
# provision-edge.sh — make Signara reachable publicly through the NPM edge.
#   1. DNS: CNAMEs (app/api.signara.<base> -> innotel.us apex) via TSIG nsupdate.
#   2. NPM proxy hosts: https://app.signara.<base> -> http://192.168.1.46:3000
#      and https://api.signara.<base> -> http://192.168.1.46:8000, each with a
#      single-name Let's Encrypt cert (HTTP-01; NPM wildcard issuance is broken).
set -euo pipefail
CERULEAN_ENV="${CERULEAN_ENV:-/usr/src/projects/complete/cerulean-dns-platform/.env}"
[ -f "$CERULEAN_ENV" ] && set -a && . "$CERULEAN_ENV" && set +a

BIND_SERVER="${BIND_SERVER:-192.168.1.80}"
BIND_TSIG_NAME="${BIND_TSIG_NAME:-cerulean}"
FORWARD_HOST="${FORWARD_HOST:-192.168.1.46}"
BASE_DOMAIN="${BASE_DOMAIN:-innotel.us}"
NPM_API_URL="${NPM_API_URL:-http://192.168.1.71:81}"
ACME_EMAIL="${ACME_EMAIL:-admin@innotel.us}"
DOMAINS=(app.signara.${BASE_DOMAIN} api.signara.${BASE_DOMAIN})

echo "== 1/2 DNS CNAMEs (TSIG nsupdate -> $BIND_SERVER) =="
if [ -n "${BIND_TSIG_SECRET:-}" ]; then
  keyfile=$(mktemp); chmod 600 "$keyfile"
  printf 'key "%s" { algorithm hmac-sha256; secret "%s"; };\n' "$BIND_TSIG_NAME" "$BIND_TSIG_SECRET" > "$keyfile"
  { echo "server $BIND_SERVER"; echo "zone ${BASE_DOMAIN}.";
    for d in "${DOMAINS[@]}"; do
      echo "update delete ${d}. CNAME"
      echo "update add ${d}. 300 CNAME ${BASE_DOMAIN}."
    done
    echo send; } | nsupdate -k "$keyfile"
  rm -f "$keyfile"
  echo "   DNS records set: ${DOMAINS[*]} -> ${BASE_DOMAIN}"
else
  echo "   BIND_TSIG_SECRET unset — skipping DNS"
fi

echo "== 2/2 NPM proxy hosts + LE certs =="
NPM_API_URL="$NPM_API_URL" NPM_EMAIL="$NPM_EMAIL" NPM_PASSWORD="$NPM_PASSWORD" \
ACME_EMAIL="$ACME_EMAIL" FORWARD_HOST="$FORWARD_HOST" BASE_DOMAIN="$BASE_DOMAIN" \
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
    (f"app.signara.{base}", 3000, True,  le_meta),
    (f"api.signara.{base}", 8000, False, le_meta),
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
        payload["id"] = existing["id"]
        req("PUT", f"/api/nginx/proxy-hosts/{existing['id']}", payload)
        print(f"   updated {domain} (host {existing['id']})")
    else:
        out = req("POST", "/api/nginx/proxy-hosts", payload)
        print(f"   created {domain} (host {out['id']})")
PY

echo "== verify =="
for d in "${DOMAINS[@]}"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://${d}/" || true)
  echo "   https://${d} -> ${code}"
done
