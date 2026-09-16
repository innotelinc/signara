#!/usr/bin/env bash
# Smoke test for the onyx-objectstore S3-compatible endpoint, over plain REST.
#
# UPDATE: the S3 gateway milestone has shipped. The store now speaks AWS SigV4 —
# header auth *and* presigned URLs — so real SDKs work against it, and
# scripts/onyx-s3-test.mjs drives a MinIO SDK through put/get/presign/read/
# delete. That is the check to run when integrating a client.
#
# This script stays because it needs nothing but curl, which is the right tool
# when the suspect is the store itself rather than the signing: it proves the
# endpoint is up, reachable and storing bytes without a client library in the
# way. It authenticates with HTTP Basic, which the store still accepts for
# backwards compatibility (see authenticateS3Request in
# services/objectstore/sigv4.go).
#
# Usage: ONYX_OBJECTSTORE_URL=http://127.0.0.1:2090 \
#        S3_ACCESS_KEY=... S3_SECRET_KEY=... ./onyx-objectstore-smoke.sh
set -euo pipefail

EP="${ONYX_OBJECTSTORE_URL:-http://127.0.0.1:2090}"
AK="${S3_ACCESS_KEY:?S3_ACCESS_KEY required}"
SK="${S3_SECRET_KEY:?S3_SECRET_KEY required}"
BUCKET="${S3_BUCKET:-signara-documents}"
AUTH="$AK:$SK"
# Every object call is addressed under the bucket. The put/get/delete steps used
# to build their URLs as "$EP/$KEY", which omits it — so they asked for an object
# in a bucket named after the key's first segment and got a correct 404 from the
# store. The script was wrong, not the store.
BASE="$EP/$BUCKET"
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

# Creating a bucket that already exists answers 409, and that is not a failure —
# the store is doing the right thing. Treating it as one made this script pass
# only on a host where the bucket had never been made, which is why it reported
# FAIL against a working deployment.
create_bucket() {
  local code
  code=$(curl -sS -m 15 -u "$AUTH" -X PUT "$EP/$BUCKET" -o /dev/null -w '%{http_code}')
  case "$code" in
    2*)  printf '%s: HTTP %s\n' "create bucket" "$code" ;;
    409) printf '%s: HTTP %s (already exists — fine)\n' "create bucket" "$code" ;;
    *)   printf '%s: HTTP %s — FAIL\n' "create bucket" "$code"; exit 1 ;;
  esac
}

echo "=== 1. create bucket ==="
create_bucket

echo "=== 2. put object ==="
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
echo "onyx-objectstore smoke test $(date -Is)" > "$TMP"
expect2xx "put object" -X PUT "$BASE/$KEY" \
  --data-binary @"$TMP" -H "Content-Type: text/plain"

echo "=== 3. get object (content matches) ==="
BODY=$(curl -sS -m 15 -u "$AUTH" "$BASE/$KEY")
if [ "$BODY" = "$(cat "$TMP")" ]; then
  echo "content OK"
else
  echo "CONTENT MISMATCH — expected $(wc -c <"$TMP") bytes, got $(printf '%s' "$BODY" | wc -c)"
  exit 1
fi

echo "=== 4. list bucket (smoke key visible) ==="
curl -sS -m 15 -u "$AUTH" "$BASE" | grep -o "<Key>[^<]*</Key>" | grep -F "$KEY" || {
  echo "smoke key missing from bucket listing — FAIL"; exit 1;
}

echo "=== 5. delete object ==="
expect2xx "delete object" -X DELETE "$BASE/$KEY"

echo "=== 6. the deleted object is really gone ==="
# A delete that reports success but leaves the object readable is the failure
# mode worth checking for, and it is invisible without asking again.
GONE=$(curl -sS -m 15 -u "$AUTH" -o /dev/null -w '%{http_code}' "$BASE/$KEY")
case "$GONE" in
  404) printf '%s: HTTP %s\n' "get after delete" "$GONE" ;;
  *)   printf '%s: HTTP %s — FAIL (expected 404)\n' "get after delete" "$GONE"; exit 1 ;;
esac

echo "ONYX-OBJECTSTORE SMOKE TEST PASSED"
