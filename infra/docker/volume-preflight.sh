#!/bin/sh
# volume-preflight.sh — refuse to start the stack on a live volume that came up empty.
#
# Coolify can move a service from one twin volume to the other between deploys:
# the container starts, the healthcheck passes, and the only symptom is missing
# data. docker-compose.prod.yml runs this before every service that reads a
# volume (`condition: service_completed_successfully`), so a bad re-render stops
# the deploy instead of starting it on an empty directory.
#
# It runs in an alpine container that sees exactly one thing: the host's
# /var/lib/docker/volumes, mounted read-only. That is why it lives on the host
# (`/usr/local/bin/volume-preflight.sh`) rather than inside the repo checkout:
# install it from infra/docker/volume-preflight.sh, which is the source of truth.
#
#   install -m 0755 infra/docker/volume-preflight.sh /usr/local/bin/volume-preflight.sh
#
# Usage: volume-preflight.sh [/volumes]   (exit 0 = safe to start)
set -eu

ROOT=${1:-/volumes}
PREFIX=${VOLUME_PREFIX:-signara_}
failed=0

# dataset:canonical-key:alternate,keys
#
# The canonical key is the volume name the repository compose declares today.
# The alternates are the names an earlier render gave the same data — a rename
# in the compose file, or a different project prefix, leaves the old directory
# behind holding the real rows. Checking only the canonical key would miss the
# case that matters: the render moved the service to a fresh key, so the new key
# is empty and the data is sitting under the old one.
DATASETS='
pgdata:pgdata:postgres_data,pg_data,postgresdata
redisdata:redisdata:redis_data
miniodata:miniodata:minio_data
meilidata:meilidata:meili_data,meilisearch_data
promdata:promdata:prometheus_data
alertdata:alertdata:alertmanager_data
backupcache:backupcache:backup_cache
authentikdb:authentikdb:authentik_db
authentikredis:authentikredis:authentik_redis
'

has_data() { # <dir> -> 0 when the directory exists and holds at least one entry
  [ -d "$1" ] || return 1
  [ -n "$(ls -A "$1" 2>/dev/null | head -n 1)" ]
}

printf 'volume-preflight: root=%s prefix=%s\n' "$ROOT" "$PREFIX"

for line in $DATASETS; do
  dataset=${line%%:*}
  rest=${line#*:}
  live_key=${rest%%:*}
  alts=${rest#*:}

  live="$ROOT/$PREFIX$live_key/_data"
  if has_data "$live"; then
    printf '  %-16s ok   %s\n' "$dataset" "$PREFIX$live_key"
    continue
  fi

  holders=''
  for alt in $(printf '%s' "$alts" | tr ',' ' '); do
    [ -n "$alt" ] || continue
    if has_data "$ROOT/$PREFIX$alt/_data"; then
      holders="$holders $PREFIX$alt"
    fi
  done

  if [ -n "$holders" ]; then
    printf '  %-16s FAIL %s is empty or missing, but%s holds data\n' \
      "$dataset" "$PREFIX$live_key" "$holders" >&2
    failed=1
  else
    printf '  %-16s new  %s has no data yet (first start)\n' "$dataset" "$PREFIX$live_key"
  fi
done

if [ "$failed" -ne 0 ]; then
  cat >&2 <<'MSG'
volume-preflight: refusing to start. A live volume is empty while the twin that
holds its data is still on disk, so starting now would serve an empty database.
Fix the volume mapping (or move the data back) and run the deploy again.
Nothing has been started.
MSG
  exit 1
fi

printf 'volume-preflight: every live volume is safe to mount\n'
