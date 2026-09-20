#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backup-cache}"
DUMP_FILE="${1:-}"

# Every object transfer here is rclone, matching backup.sh: the estate's object
# store refuses streaming SigV4 payloads, which mc sends on every PUT — so a
# restore that fetched from the mirror with mc would fail to put the objects
# back, having read them perfectly well. Remote flags are built per store below;
# this helper keeps the S3 shape in one place.
# Fills the named array with the flags for one store. A nameref rather than a
# printed list: credentials are arbitrary strings, and anything that round-trips
# them through word splitting is one space away from sending the wrong key.
s3_flags() { # $1 = array name, $2 = endpoint, $3 = access key, $4 = secret, $5 = region
  local -n out="$1"
  out=(--config /dev/null --log-level ERROR --s3-provider Other
    --s3-endpoint "$2" --s3-access-key-id "$3" --s3-secret-access-key "$4"
    --s3-force-path-style)
  if [[ -n "${5:-}" ]]; then
    out+=(--s3-region "$5")
  fi
}

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
    s3_flags mirror_flags "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" "${BACKUP_S3_REGION:-}"
    mkdir -p "$BACKUP_DIR"
    rclone "${mirror_flags[@]}" copyto \
      ":s3:$BACKUP_S3_BUCKET/postgres/db-${REMOTE_TIMESTAMP}.dump" \
      "$BACKUP_DIR/db-${REMOTE_TIMESTAMP}.dump"
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
  s3_flags mirror_flags "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" "${BACKUP_S3_REGION:-}"
  # Absent is a legitimate state (see backup.sh): not every deployment keeps its
  # identity database in this stack, so a missing identity dump must not abort a
  # restore that is otherwise complete for Signara's own data.
  if rclone "${mirror_flags[@]}" copyto \
    ":s3:$BACKUP_S3_BUCKET/authentik/authentik-db-${BACKUP_TIMESTAMP}.dump" \
    "$BACKUP_DIR/authentik-db-${BACKUP_TIMESTAMP}.dump" 2>/dev/null; then
    AUTHENTIK_DUMP="$BACKUP_DIR/authentik-db-${BACKUP_TIMESTAMP}.dump"
  else
    echo "[restore] the mirror has no identity dump for $BACKUP_TIMESTAMP; restoring Signara only" >&2
  fi
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
  s3_flags source_flags "$SOURCE_S3_ENDPOINT" "$SOURCE_S3_ACCESS_KEY" "$SOURCE_S3_SECRET_KEY" "${SOURCE_S3_REGION:-}"
  rclone "${source_flags[@]}" mkdir ":s3:$SOURCE_S3_BUCKET"
  if [[ -d "$local_archive" ]]; then
    echo "[restore] restoring objects into the source bucket from local archive $OBJECT_TIMESTAMP"
    rclone "${source_flags[@]}" copy "$local_archive" ":s3:$SOURCE_S3_BUCKET"
  else
    : "${BACKUP_S3_ENDPOINT:?BACKUP_S3_ENDPOINT is required when the local object archive is unavailable}"
    : "${BACKUP_S3_ACCESS_KEY:?BACKUP_S3_ACCESS_KEY is required when the local object archive is unavailable}"
    : "${BACKUP_S3_SECRET_KEY:?BACKUP_S3_SECRET_KEY is required when the local object archive is unavailable}"
    : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required when the local object archive is unavailable}"
    s3_flags mirror_flags "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" "${BACKUP_S3_REGION:-}"
    # Stage the archive out of the mirror before putting it back: the mirror is a
    # copy of objects that already exist in the source bucket, and copying remote
    # to remote through a local directory is what makes the write observable —
    # an interrupted transfer fails loudly instead of half-updating the store.
    staging="${BACKUP_DIR}/minio/${OBJECT_TIMESTAMP}.restore"
    mkdir -p "$staging"
    rclone "${mirror_flags[@]}" copy ":s3:$BACKUP_S3_BUCKET/minio/$OBJECT_TIMESTAMP" "$staging"
    rclone "${source_flags[@]}" copy "$staging" ":s3:$SOURCE_S3_BUCKET"
    rm -rf "$staging"
  fi
  echo "[restore] objects restored from timestamp $OBJECT_TIMESTAMP"
fi
