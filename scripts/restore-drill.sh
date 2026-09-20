#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# restore-drill.sh — prove that a Signara backup can be restored, without
# touching the deployment.
#
# Why this exists: the estate lost a platform's entire history because its
# backups were never restored, only written, and the only copy lived on the box
# that died (see 1-primary/sign/ARCHIVE.md §8). The roadmap's W6 exit is
# therefore "a restore drill recorded as a dated entry in DisasterRecovery.md,
# not a plan" — and a plan is what an unrun script is, so this one is meant to
# be run monthly and its output pasted into that document.
#
# It never touches the running stack. It creates two throwaway Postgres
# containers named signara-drill-*, restores into the second one with the exact
# pg_restore invocation infra/backup/restore.sh uses, checks what came back, and
# removes both — including when it fails.
#
#   scripts/restore-drill.sh                       # seed a drill database from
#                                                  # this repo's migrations
#   scripts/restore-drill.sh --dump /path/to.dump  # drill a real backup
#   scripts/restore-drill.sh --dump x.dump --keep  # leave the target running
#
# Seed mode needs the repo's toolchain (node_modules/.bin/prisma) to apply
# migrations; dump mode needs only docker, so an operator can drill the
# production dump from a laptop. Exit code is 0 only if every check passed.
# ═══════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${DRILL_IMAGE:-postgres:16-alpine}"
PG_USER="${POSTGRES_USER:-signara}"
PG_PASSWORD="${POSTGRES_PASSWORD:-signara}"
PG_DB="${POSTGRES_DB:-signara}"
SCHEMA="$REPO_ROOT/packages/database/prisma/schema.prisma"

DUMP=""
KEEP=false
FORCED_PORT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dump) DUMP="${2:?--dump needs a file}"; shift 2 ;;
    --port) FORCED_PORT="${2:?--port needs a number}"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    -h | --help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
done

SUFFIX="$$"
SRC="signara-drill-src-$SUFFIX"
DST="signara-drill-dst-$SUFFIX"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/signara-drill.XXXXXX")"
PORT=""

say() { printf '[drill] %s\n' "$*"; }
fail() { printf '[drill] FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  local code=$?
  if [[ "$KEEP" == true ]]; then
    say "--keep: leaving $SRC and $DST running (docker rm -f $SRC $DST when done)"
    [[ -n "$DUMP" ]] || say "     the drill dump is at $WORKDIR/drill.dump"
    return "$code"
  fi
  docker rm -f "$SRC" "$DST" >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
  return "$code"
}
trap cleanup EXIT

psql_src() { docker exec -i "$SRC" psql -qtAX -U "$PG_USER" -d "$PG_DB" "$@"; }
psql_dst() { docker exec -i "$DST" psql -qtAX -U "$PG_USER" -d "$PG_DB" "$@"; }
# Identifiers are quoted because Prisma creates CamelCase tables ("Organization",
# "Document") and an unquoted name is folded to lower case by Postgres — which
# reads as "the table is missing" and turns a good restore into a failed drill.
count_dst() { psql_dst -c "select count(*) from \"$1\""; }

start_pg() { # $1 = container, $2 = published port or ''
  # One statement per assignment: `local a=$1 b=("$a")` expands the array before
  # `a` exists, and `set -u` turns that into "a: unbound variable".
  local name="$1"
  local port="$2"
  local args=(--rm -d --name "$name" -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_USER="$PG_USER" -e POSTGRES_DB="$PG_DB")
  [[ -n "$port" ]] && args+=(-p "127.0.0.1:$port:5432")
  docker run "${args[@]}" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$name" pg_isready -q -U "$PG_USER" -d "$PG_DB" 2>/dev/null && return 0
    sleep 1
  done
  fail "$name never became ready"
}

command -v docker >/dev/null || fail "docker is required"
docker image inspect "$IMAGE" >/dev/null 2>&1 || say "pulling $IMAGE (not present locally)"

# The dump is listed inside a container so that dump mode needs nothing but
# docker on the operator's machine — the point is to be runnable from anywhere a
# production dump is, not only on a host with the Postgres toolchain.
list_dump() {
  docker run --rm -v "$WORKDIR:/drill:ro" "$IMAGE" pg_restore -l /drill/drill.dump 2>/dev/null || true
}

bytes_of() { stat -c %s "$1" 2>/dev/null || stat -f %z "$1"; }

# ── Build the thing to restore ───────────────────────────────────────────────
if [[ -n "$DUMP" ]]; then
  [[ -f "$DUMP" ]] || fail "no such dump: $DUMP"
  say "drilling the provided backup: $DUMP"
  cp "$DUMP" "$WORKDIR/drill.dump"
  # A dump of the wrong database restores perfectly and proves nothing, so the
  # core tables have to be in it.
  listing="$(list_dump)"
  # pg_restore -l prints "<n>; <oid> <oid> TABLE DATA <schema> <name> <owner>":
  # the table name is the seventh field and the owner is last. Matching the last
  # field rejected every real dump, including this project's own.
  data_tables="$(awk '$4 == "TABLE" && $5 == "DATA" {print $7}' <<<"$listing")"
  if [[ -n "$data_tables" ]]; then data_count="$(wc -l <<<"$data_tables" | tr -d ' ')"; else data_count=0; fi
  for t in Organization Document User; do
    grep -qx "$t" <<<"$data_tables" ||
      fail "$DUMP carries no $t table data (it lists $data_count data tables) — is this a Signara dump?"
  done
  say "the dump carries $data_count table-data entries"
else
  command -v node >/dev/null || fail "seed mode needs node (or pass --dump)"
  [[ -x "$REPO_ROOT/node_modules/.bin/prisma" ]] || fail "seed mode needs node_modules/.bin/prisma (run npm install, or pass --dump)"
  [[ -f "$SCHEMA" ]] || fail "missing $SCHEMA"

  say "seed mode: creating a source database from this repo's migrations"
  # Prisma runs on the host, so the source has to publish a loopback port. It is
  # picked free, then *verified reachable* before Prisma is invoked: a port that
  # is free but not yet accepting turns into a P1001 that looks like a broken
  # drill, and a drill that flakes is worse than none. Pass --port to pin it.
  if [[ -n "$FORCED_PORT" ]]; then
    PORT="$FORCED_PORT"
  else
    for _ in $(seq 1 25); do
      candidate=$((55000 + RANDOM % 999))
      (exec 3<>"/dev/tcp/127.0.0.1/$candidate") 2>/dev/null || { PORT="$candidate"; break; }
      exec 3>&- 2>/dev/null || true
    done
  fi
  [[ -n "$PORT" ]] || fail "no free loopback port in 55000-55998"
  start_pg "$SRC" "$PORT"
  for _ in $(seq 1 20); do
    (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null && { exec 3>&-; break; }
    sleep 1
    (( _ == 20 )) && fail "$SRC is up but 127.0.0.1:$PORT is not reachable — is this host inside a container without port publishing?"
  done
  say "source database is reachable on 127.0.0.1:$PORT"

  say "applying migrations to the source database"
  (cd "$REPO_ROOT" &&
    DATABASE_URL="postgresql://$PG_USER:$PG_PASSWORD@127.0.0.1:$PORT/$PG_DB?schema=public" \
      node_modules/.bin/prisma migrate deploy --schema "$SCHEMA" >/dev/null) ||
    fail "prisma migrate deploy failed"

  # Sentinels: a small relational cluster plus the checksum that anchors
  # tamper-evidence, so the restore is checked on values rather than row counts.
  say "writing sentinel rows"
  psql_src <<'SQL' >/dev/null
insert into "Organization" (id, name, slug, "updatedAt") values
  ('11111111-1111-1111-1111-111111111111', 'Drill Org', 'drill-org', now());
insert into "User" (id, email, "displayName", "updatedAt") values
  ('22222222-2222-2222-2222-222222222222', 'drill@example.invalid', 'Drill User', now());
insert into "Workspace" (id, "organizationId", name, slug, "updatedAt") values
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Drill WS', 'drill-ws', now());
insert into "Document" (id, "organizationId", "workspaceId", title, "fileName", "fileKey", "checksumSha256", "updatedAt") values
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
   '33333333-3333-3333-3333-333333333333', 'Drill document', 'drill.pdf',
   'drill-org/documents/drill.pdf',
   '7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069', now());
SQL

  say "taking the backup the way infra/backup/backup.sh does (pg_dump -Fc)"
  docker exec "$SRC" pg_dump -U "$PG_USER" -d "$PG_DB" -Fc --no-owner --file /tmp/drill.dump
  docker cp "$SRC:/tmp/drill.dump" "$WORKDIR/drill.dump" >/dev/null
fi

DUMP_SHA="$(sha256sum "$WORKDIR/drill.dump" | cut -d' ' -f1)"
DUMP_BYTES="$(bytes_of "$WORKDIR/drill.dump")"
say "backup under test: sha256 $DUMP_SHA, $DUMP_BYTES bytes"

# ── Restore it ──────────────────────────────────────────────────────────────
say "creating the target database"
start_pg "$DST" ""
docker cp "$WORKDIR/drill.dump" "$DST:/tmp/drill.dump" >/dev/null

say "restoring (the invocation infra/backup/restore.sh uses)"
# --clean --if-exists --exit-on-error: the failure this catches is a restore
# that half-succeeds, which is why the flag that stops on first error is the one
# that matters here.
if ! docker exec "$DST" pg_restore -U "$PG_USER" -d "$PG_DB" \
  --clean --if-exists --exit-on-error /tmp/drill.dump 2>"$WORKDIR/restore.err"; then
  tail -5 "$WORKDIR/restore.err" >&2
  fail "pg_restore did not complete"
fi

# ── Check what came back ────────────────────────────────────────────────────
errors=0
check() { # $1 = label, $2 = expected, $3 = actual
  local mark="ok  "
  [[ "$2" == "$3" ]] || { mark="FAIL"; errors=$((errors + 1)); }
  printf '  %s %-42s expected %-8s got %s\n' "$mark" "$1" "$2" "$3"
}

say "checks"
dst_migrations="$(count_dst _prisma_migrations 2>/dev/null || echo 0)"
if [[ "$dst_migrations" =~ ^[0-9]+$ ]] && (( dst_migrations > 0 )); then
  printf '  %s %-42s %s\n' "ok  " "_prisma_migrations rows" "$dst_migrations"
else
  printf '  %s %-42s %s\n' "FAIL" "_prisma_migrations rows" "$dst_migrations"
  errors=$((errors + 1))
fi

if [[ -z "$DUMP" ]]; then
  check "Organization rows" "$(psql_src -c 'select count(*) from "Organization"')" "$(count_dst Organization)"
  check "User rows" "$(psql_src -c 'select count(*) from "User"')" "$(count_dst User)"
  check "Workspace rows" "$(psql_src -c 'select count(*) from "Workspace"')" "$(count_dst Workspace)"
  check "Document rows" "$(psql_src -c 'select count(*) from "Document"')" "$(count_dst Document)"
  check "public tables" "$(psql_src -c "select count(*) from information_schema.tables where table_schema='public'")" \
    "$(psql_dst -c "select count(*) from information_schema.tables where table_schema='public'")"
  check "document checksum survives" \
    "7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069" \
    "$(psql_dst -c "select \"checksumSha256\" from \"Document\" where id='44444444-4444-4444-4444-444444444444'")"
  check "workspace → organization intact" "1" \
    "$(psql_dst -c "select count(*) from \"Workspace\" w join \"Organization\" o on o.id = w.\"organizationId\"")"
else
  # No sentinels to compare against in dump mode: report what the restore
  # actually contains and let the operator judge, rather than invent an
  # expectation the dump was never asked to meet. A zero here on a production
  # dump is a finding about the dump, not about the restore.
  total=0
  for t in Organization User Document SignatureRequest AuditLog; do
    rows="$(count_dst "$t" 2>/dev/null || echo 'n/a')"
    printf '  %-30s %s\n' "$t rows" "$rows"
    [[ "$rows" =~ ^[0-9]+$ ]] && total=$((total + rows))
  done
  if (( total == 0 )); then
    say "WARNING: the core tables restored empty — confirm the dump is the one you meant to drill"
  fi
fi

echo
if (( errors == 0 )); then
  say "PASS — the backup restored and its content is intact"
  say "record this run (date, dump sha256, checks) in docs/DisasterRecovery.md §4"
  exit 0
fi
fail "$errors check(s) did not pass — the backup is NOT proven restorable"
