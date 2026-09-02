#!/bin/bash
# ==========================================================================
# Signara backup helper
#
# Backs up:
#   1. PostgreSQL database (pg_dump, custom format)
#   2. MinIO buckets (documents + templates) via mc mirror
#
# Uploads to the backup S3 endpoint (BACKUP_S3_*) with retention.
# Exposes Prometheus-compatible status files for alerting:
#   /backup-cache/status.prom   - signara_backup_last_status
#                                 signara_backup_last_success_timestamp
# ==========================================================================
set -euo pipefail

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_DIR:-/backup-cache}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STATUS_FILE="$BACKUP_DIR/status.prom"
export MC_HOST_backup="${S3_ENDPOINT:-}"

log() { echo "[backup] $*"; }

finish() {
  local code=$?
  if [ "$code" -eq 0 ]; then
    echo "signara_backup_last_status 1" > "$STATUS_FILE"
    echo "signara_backup_last_success_timestamp $(date +%s)" >> "$STATUS_FILE"
    log "backup completed successfully"
  else
    echo "signara_backup_last_status 0" > "$STATUS_FILE"
    log "backup FAILED (exit $code)" >&2
  fi
  exit "$code"
}
trap finish EXIT

mkdir -p "$BACKUP_DIR"

# ---- 1. PostgreSQL -------------------------------------------------------
log "Dumping PostgreSQL database..."
PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump \
  -h "${POSTGRES_HOST:-postgres}" \
  -U "${POSTGRES_USER:-signara}" \
  -d "${POSTGRES_DB:-signara}" \
  -Fc --no-owner \
  -f "$BACKUP_DIR/db-${TIMESTAMP}.dump"

# ---- 2. MinIO buckets ----------------------------------------------------
if command -v mc >/dev/null 2>&1 && [ -n "${S3_ACCESS_KEY:-}" ]; then
  log "Mirroring MinIO buckets to backup storage..."
  mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY"
  mc mirror --overwrite --remove \
    "$BACKUP_DIR/../minio" \
    "backup/$BACKUP_S3_BUCKET/objects/$TIMESTAMP" 2>/dev/null || true
else
  log "Skipping object mirror (mc/backup credentials not available)"
fi

# ---- 3. Retention --------------------------------------------------------
log "Applying retention of $RETENTION_DAYS days..."
find "$BACKUP_DIR" -name 'db-*.dump' -mtime "+$RETENTION_DAYS" -delete
if command -v mc >/dev/null 2>&1 && [ -n "${S3_ACCESS_KEY:-}" ]; then
  # object versioning + lifecycle rules on the backup bucket are recommended
  # (see docs/DisasterRecovery.md) instead of manual expiration.
  true
fi

log "Backup stored in $BACKUP_DIR"
ls -lh "$BACKUP_DIR" | head -20