#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backup-cache}"
DUMP_FILE="${1:-}"

if [[ -z "$DUMP_FILE" ]]; then
  DUMP_FILE="$(ls -t "$BACKUP_DIR"/db-*.dump 2>/dev/null | head -1 || true)"
fi

# If local retention has removed the dump, fetch the selected remote archive.
if [[ -z "$DUMP_FILE" || ! -f "$DUMP_FILE" ]]; then
  if [[ -n "${BACKUP_S3_ENDPOINT:-}" && -n "${BACKUP_S3_ACCESS_KEY:-}" && -n "${BACKUP_S3_SECRET_KEY:-}" ]]; then
    : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required for remote restore}"
    REMOTE_TIMESTAMP="${BACKUP_TIMESTAMP:-}"
    if [[ -z "$REMOTE_TIMESTAMP" ]]; then
      echo "[restore] set BACKUP_TIMESTAMP when the local database dump is unavailable" >&2
      exit 1
    fi
    mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null
    mkdir -p "$BACKUP_DIR"
    mc cp "backup/$BACKUP_S3_BUCKET/postgres/db-${REMOTE_TIMESTAMP}.dump" "$BACKUP_DIR/"
    DUMP_FILE="$BACKUP_DIR/db-${REMOTE_TIMESTAMP}.dump"
  else
    echo "[restore] no Signara database dump found in $BACKUP_DIR" >&2
    exit 1
  fi
fi

if [[ "${CONFIRM_RESTORE:-}" != "true" ]]; then
  echo "[restore] this replaces the target database. Set CONFIRM_RESTORE=true to continue." >&2
  exit 1
fi

PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}" pg_restore \
  -h "${POSTGRES_HOST:-postgres}" \
  -U "${POSTGRES_USER:-signara}" \
  -d "${POSTGRES_DB:-signara}" \
  --clean --if-exists --exit-on-error "$DUMP_FILE"
echo "[restore] Signara database restored from $DUMP_FILE"

AUTHENTIK_DUMP="${2:-}"
if [[ -z "$AUTHENTIK_DUMP" ]]; then
  AUTHENTIK_DUMP="$(ls -t "$BACKUP_DIR"/authentik-db-*.dump 2>/dev/null | head -1 || true)"
fi
if [[ -z "$AUTHENTIK_DUMP" && -n "${BACKUP_TIMESTAMP:-}" && -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
  : "${BACKUP_S3_ACCESS_KEY:?BACKUP_S3_ACCESS_KEY is required for remote restore}"
  : "${BACKUP_S3_SECRET_KEY:?BACKUP_S3_SECRET_KEY is required for remote restore}"
  : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required for remote restore}"
  mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null
  mc cp "backup/$BACKUP_S3_BUCKET/authentik/authentik-db-${BACKUP_TIMESTAMP}.dump" "$BACKUP_DIR/"
  AUTHENTIK_DUMP="$BACKUP_DIR/authentik-db-${BACKUP_TIMESTAMP}.dump"
fi
if [[ -n "$AUTHENTIK_DUMP" && -f "$AUTHENTIK_DUMP" ]]; then
  PGPASSWORD="${AUTHENTIK_POSTGRES_PASSWORD:?AUTHENTIK_POSTGRES_PASSWORD is required}" pg_restore \
    -h "${AUTHENTIK_POSTGRES_HOST:-authentik-db}" \
    -U "${AUTHENTIK_POSTGRES_USER:-authentik}" \
    -d "${AUTHENTIK_POSTGRES_DB:-authentik}" \
    --clean --if-exists --exit-on-error "$AUTHENTIK_DUMP"
  echo "[restore] Authentik database restored from $AUTHENTIK_DUMP"
fi

OBJECT_TIMESTAMP="${OBJECT_TIMESTAMP:-}"
if [[ -n "$OBJECT_TIMESTAMP" ]]; then
  : "${SOURCE_S3_ENDPOINT:?SOURCE_S3_ENDPOINT is required for object restore}"
  : "${SOURCE_S3_ACCESS_KEY:?SOURCE_S3_ACCESS_KEY is required for object restore}"
  : "${SOURCE_S3_SECRET_KEY:?SOURCE_S3_SECRET_KEY is required for object restore}"
  : "${SOURCE_S3_BUCKET:?SOURCE_S3_BUCKET is required for object restore}"

  local_archive="$BACKUP_DIR/minio/$OBJECT_TIMESTAMP"
  mc alias set source "$SOURCE_S3_ENDPOINT" "$SOURCE_S3_ACCESS_KEY" "$SOURCE_S3_SECRET_KEY" >/dev/null
  if [[ -d "$local_archive" ]]; then
    echo "[restore] restoring MinIO objects from local archive $OBJECT_TIMESTAMP"
    mc mb --ignore-existing "source/$SOURCE_S3_BUCKET" >/dev/null
    mc mirror --overwrite "$local_archive" "source/$SOURCE_S3_BUCKET"
  else
    : "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required when the local object archive is unavailable}"
    : "${BACKUP_S3_ACCESS_KEY:?BACKUP_S3_ACCESS_KEY is required when the local object archive is unavailable}"
    : "${BACKUP_S3_SECRET_KEY:?BACKUP_S3_SECRET_KEY is required when the local object archive is unavailable}"
    : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required when the local object archive is unavailable}"
    mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null
    mc mirror --overwrite "backup/$BACKUP_S3_BUCKET/minio/$OBJECT_TIMESTAMP" "source/$SOURCE_S3_BUCKET"
  fi
  echo "[restore] MinIO objects restored from timestamp $OBJECT_TIMESTAMP"
fi
