#!/usr/bin/env bash
# Smoke test for onyx-objectstore (v0.1) S3-compatible endpoint.
#
# NOTE: onyx-objectstore v0.1 authenticates with HTTP Basic auth
# (S3_ACCESS_KEY/S3_SECRET_KEY) — AWS SigV4/presigned URLs land with the
# S3 gateway milestone (services/objectstore/http.go in onyx-oss-platform).
# MinIO/S3 SDKs therefore cannot be used against it yet; plain REST calls
# like these are the correct v0.1 verification.
# (scripts/onyx-s3-test.mjs is the forward probe for that milestone.)
#
# Usage: ONYX_OBJECTSTORE_URL=http://127.0.0.1:2090 \
#        S3_ACCESS_KEY=... S3_SECRET_KEY=... ./onyx-objectstore-smoke.sh
set -euo pipefail

EP="${ONYX_OBJECTSTORE_URL:-http://127.0.0.1:2090}"
AK="${S3_ACCESS_KEY:?S3_ACCESS_KEY required}"
SK="${S3_SECRET_KEY:?S3_SECRET_KEY required}"
BUCKET="${S3_BUCKET:-signara-documents}"
AUTH="$AK:$SK"
KEY="smoke-test/$$.txt"

# curl exits 0 even when the server answers 401/500, so every call's HTTP
# code is checked explicitly — anything non-2xx fails the smoke test.
expect2xx() {
  local label="$1" code
  shift
  code=$(curl -sS -m 15 -u "$AUTH" "$@" -o /dev/null -w '%{http_code}')
  case "$code" in
    2*) printf '%s: HTTP %s\n' "$label" "$code" ;;
    *)  printf '%s: HTTP %s — FAIL\n' "$label" "$code"; exit 1 ;;
  esac
}

echo "endpoint: $EP"
echo "bucket:   $BUCKET"

echo "=== 1. create bucket ==="
expect2xx "create bucket" -X PUT "$EP/$BUCKET"

echo "=== 2. put object ==="
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
echo "onyx-objectstore smoke test $(date -Is)" > "$TMP"
expect2xx "put object" -X PUT "$EP/$KEY" \
  --data-binary @"$TMP" -H "Content-Type: text/plain"

echo "=== 3. get object (content matches) ==="
BODY=$(curl -sS -m 15 -u "$AUTH" "$EP/$KEY")
if [ "$BODY" = "$(cat "$TMP")" ]; then echo "content OK"; else echo "CONTENT MISMATCH"; exit 1; fi

echo "=== 4. list bucket (smoke key visible) ==="
curl -sS -m 15 -u "$AUTH" "$EP/$BUCKET" | grep -o "<Key>[^<]*</Key>" | grep -F "$KEY" || {
  echo "smoke key missing from bucket listing — FAIL"; exit 1;
}

echo "=== 5. delete object ==="
expect2xx "delete object" -X DELETE "$EP/$KEY"

echo "ONYX-OBJECTSTORE SMOKE TEST PASSED"
