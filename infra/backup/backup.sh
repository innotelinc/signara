#!/usr/bin/env bash
set -Eeuo pipefail

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_DIR:-/backup-cache}"
OBJECT_BACKUP_DIR="$BACKUP_DIR/minio/$TIMESTAMP"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STATUS_FILE="$BACKUP_DIR/status.prom"

log() { echo "[backup] $*"; }

finish() {
  local code=$?
  if (( code == 0 )); then
    {
      echo "signara_backup_last_status 1"
      echo "signara_backup_last_success_timestamp $(date +%s)"
    } > "$STATUS_FILE"
    log "backup completed successfully"
  else
    last_success="$(awk '$1 == "signara_backup_last_success_timestamp" { print $2 }' "$STATUS_FILE" 2>/dev/null || true)"
    {
      echo "signara_backup_last_status 0"
      if [[ -n "$last_success" ]]; then
        echo "signara_backup_last_success_timestamp $last_success"
      fi
    } > "$STATUS_FILE"
    log "backup failed (exit $code)" >&2
  fi
  exit "$code"
}
trap finish EXIT

mkdir -p "$BACKUP_DIR" "$OBJECT_BACKUP_DIR"

backup_database() {
  local name="$1" host="$2" user="$3" password="$4" database="$5"
  local output="$BACKUP_DIR/${name}-${TIMESTAMP}.dump"
  log "Dumping $name PostgreSQL database..."
  PGPASSWORD="$password" pg_dump \
    -h "$host" -U "$user" -d "$database" \
    -Fc --no-owner --file "$output"
}

backup_database "db" "${POSTGRES_HOST:-postgres}" "${POSTGRES_USER:-signara}" \
  "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}" "${POSTGRES_DB:-signara}"

backup_database "authentik-db" "${AUTHENTIK_POSTGRES_HOST:-authentik-db}" \
  "${AUTHENTIK_POSTGRES_USER:-authentik}" "${AUTHENTIK_POSTGRES_PASSWORD:?AUTHENTIK_POSTGRES_PASSWORD is required}" \
  "${AUTHENTIK_POSTGRES_DB:-authentik}"

: "${SOURCE_S3_ENDPOINT:?SOURCE_S3_ENDPOINT is required for object backup}"
: "${SOURCE_S3_ACCESS_KEY:?SOURCE_S3_ACCESS_KEY is required for object backup}"
: "${SOURCE_S3_SECRET_KEY:?SOURCE_S3_SECRET_KEY is required for object backup}"
: "${SOURCE_S3_BUCKET:?SOURCE_S3_BUCKET is required for object backup}"

log "Creating a local MinIO object archive..."
mc alias set source "$SOURCE_S3_ENDPOINT" "$SOURCE_S3_ACCESS_KEY" "$SOURCE_S3_SECRET_KEY" >/dev/null
mc mb --ignore-existing "source/$SOURCE_S3_BUCKET" >/dev/null
mc mirror --overwrite "source/$SOURCE_S3_BUCKET" "$OBJECT_BACKUP_DIR"

if [[ -n "${BACKUP_S3_ENDPOINT:-}" || -n "${BACKUP_S3_ACCESS_KEY:-}" || -n "${BACKUP_S3_SECRET_KEY:-}" ]]; then
  if [[ -z "${BACKUP_S3_ENDPOINT:-}" || -z "${BACKUP_S3_ACCESS_KEY:-}" || -z "${BACKUP_S3_SECRET_KEY:-}" ]]; then
    log "Remote backup configuration is incomplete" >&2
    exit 1
  fi
  : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required for remote backup}"

  log "Mirroring the local backup archive to remote S3..."
  mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null
  mc mb --ignore-existing "backup/$BACKUP_S3_BUCKET" >/dev/null
  mc mirror --overwrite "$OBJECT_BACKUP_DIR" "backup/$BACKUP_S3_BUCKET/minio/$TIMESTAMP"
  mc cp --quiet "$BACKUP_DIR/db-${TIMESTAMP}.dump" "backup/$BACKUP_S3_BUCKET/postgres/"
  mc cp --quiet "$BACKUP_DIR/authentik-db-${TIMESTAMP}.dump" "backup/$BACKUP_S3_BUCKET/authentik/"
  mc rm --recursive --force --older-than "${RETENTION_DAYS}d" "backup/$BACKUP_S3_BUCKET/minio" >/dev/null 2>&1 || true
  mc rm --recursive --force --older-than "${RETENTION_DAYS}d" "backup/$BACKUP_S3_BUCKET/postgres" >/dev/null 2>&1 || true
  mc rm --recursive --force --older-than "${RETENTION_DAYS}d" "backup/$BACKUP_S3_BUCKET/authentik" >/dev/null 2>&1 || true
else
  if [[ "${BACKUP_REQUIRE_REMOTE:-false}" == "true" ]]; then
    log "Remote backup credentials are required but missing" >&2
    exit 1
  fi
  log "Remote S3 backup is disabled; retaining local backup files only"
fi

log "Applying local retention of $RETENTION_DAYS days..."
find "$BACKUP_DIR" -type f \( -name 'db-*.dump' -o -name 'authentik-db-*.dump' \) \
  -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR/minio" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -exec rm -rf {} +

log "Backup stored in $BACKUP_DIR"
ls -lh "$BACKUP_DIR" | head -20
