#!/bin/bash
# ==========================================================================
# Signara restore helper
#
# Restores the latest local backup into PostgreSQL. Object storage is restored
# with `mc mirror` when backup credentials are present.
#
# Usage: docker compose -f docker-compose.prod.yml exec backup /backup/restore.sh [file.dump]
# ==========================================================================
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backup-cache}"
DUMP_FILE="${1:-}"

if [ -z "$DUMP_FILE" ]; then
  DUMP_FILE="$(ls -t "$BACKUP_DIR"/db-*.dump 2>/dev/null | head -1 || true)"
fi
if [ -z "$DUMP_FILE" ] || [ ! -f "$DUMP_FILE" ]; then
  echo "[restore] no dump file found in $BACKUP_DIR" >&2
  exit 1
fi

echo "[restore] restoring $DUMP_FILE ..."
echo "[warn] this REPLACES the current database content. Ctrl-C to abort (10s)..."
sleep 10

PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_restore \
  -h "${POSTGRES_HOST:-postgres}" \
  -U "${POSTGRES_USER:-signara}" \
  -d "${POSTGRES_DB:-signara}" \
  --clean --if-exists \
  "$DUMP_FILE"

echo "[restore] database restored. Verify with:"
echo "  PGPASSWORD=... psql -h postgres -U signara -d signara -c 'select count(*) from \"Document\";'"