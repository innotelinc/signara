#!/usr/bin/env bash
set -Eeuo pipefail

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="${BACKUP_DIR:-/backup-cache}"
OBJECT_BACKUP_DIR="$BACKUP_DIR/minio/$TIMESTAMP"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STATUS_FILE="$BACKUP_DIR/status.prom"

# Whether this run wrote a copy somewhere other than the box it backs up. It is
# reported as a metric and alerted on, because "backups ran" and "backups would
# survive losing this host" are different facts and only the first one had a
# signal: the estate lost a platform's whole history to exactly that gap (see
# 1-primary/sign/ARCHIVE.md §8). BACKUP_S3_* unset is a legitimate state — it is
# not allowed to be a *quiet* one.
REMOTE_CONFIGURED=false
REMOTE_OK=false

# A mirror is only off-host if it is not this host — a store on the same box
# gives no durability and must not be allowed to read as if it did. The job runs
# in a container and cannot see the host's LAN addresses, so the operator
# declares them in BACKUP_LOCAL_ADDRESSES; the endpoint is resolved and compared
# against them. No declaration means nothing is claimed: off-host is a fact to
# prove, and the alert stays up until it is proven.
MIRROR_OFFHOST=0

log() { echo "[backup] $*"; }

endpoint_host() { # strip scheme, credentials, port and path off an S3 endpoint
  printf '%s' "$1" | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##; s#\?.*$##; s#/.*$##; s#^.*@##; s#:[0-9]+$##'
}

resolve_ipv4() { # best-effort; prints nothing when the name cannot be resolved
  local host="$1"
  case "$host" in
    '' ) return 0 ;;
    *[!0-9.]* ) ;;                      # a name, needs a lookup
    * ) printf '%s\n' "$host"; return 0 ;;  # already a literal address
  esac
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$host" 2>/dev/null | awk '{ print $1 }' | grep -E '^[0-9.]+$' && return 0
  fi
  nslookup "$host" 2>/dev/null | awk -F': *' '/^Address/ { print $2 }' | grep -E '^[0-9.]+$'
  return 0
}

carried_over() { # $1 = metric name, from the previous status file
  awk -v k="$1" '$1 == k { print $2 }' "$STATUS_FILE" 2>/dev/null || true
}

finish() {
  local code=$?
  if (( code == 0 )); then
    {
      echo "signara_backup_last_status 1"
      echo "signara_backup_last_success_timestamp $(date +%s)"
      if [[ "$REMOTE_CONFIGURED" == true ]]; then
        echo "signara_backup_remote_enabled 1"
        if [[ "$REMOTE_OK" == true ]]; then
          echo "signara_backup_remote_last_success_timestamp $(date +%s)"
        else
          carried="$(carried_over signara_backup_remote_last_success_timestamp)"
          [[ -n "$carried" ]] && echo "signara_backup_remote_last_success_timestamp $carried"
        fi
      else
        echo "signara_backup_remote_enabled 0"
      fi
      echo "signara_backup_mirror_offhost $MIRROR_OFFHOST"
    } > "$STATUS_FILE"
    log "backup completed successfully"
  else
    last_success="$(carried_over signara_backup_last_success_timestamp)"
    remote_enabled="$(carried_over signara_backup_remote_enabled)"
    remote_success="$(carried_over signara_backup_remote_last_success_timestamp)"
    remote_offhost="$(carried_over signara_backup_mirror_offhost)"
    {
      echo "signara_backup_last_status 0"
      [[ -n "$last_success" ]] && echo "signara_backup_last_success_timestamp $last_success"
      [[ -n "$remote_enabled" ]] && echo "signara_backup_remote_enabled $remote_enabled"
      [[ -n "$remote_success" ]] && echo "signara_backup_remote_last_success_timestamp $remote_success"
      [[ -n "$remote_offhost" ]] && echo "signara_backup_mirror_offhost $remote_offhost"
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
  REMOTE_CONFIGURED=true

  log "Mirroring the local backup archive to remote S3..."
  mc alias set backup "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY" "$BACKUP_S3_SECRET_KEY" >/dev/null
  mc mb --ignore-existing "backup/$BACKUP_S3_BUCKET" >/dev/null
  mc mirror --overwrite "$OBJECT_BACKUP_DIR" "backup/$BACKUP_S3_BUCKET/minio/$TIMESTAMP"
  mc cp --quiet "$BACKUP_DIR/db-${TIMESTAMP}.dump" "backup/$BACKUP_S3_BUCKET/postgres/"
  mc cp --quiet "$BACKUP_DIR/authentik-db-${TIMESTAMP}.dump" "backup/$BACKUP_S3_BUCKET/authentik/"
  mc rm --recursive --force --older-than "${RETENTION_DAYS}d" "backup/$BACKUP_S3_BUCKET/minio" >/dev/null 2>&1 || true
  mc rm --recursive --force --older-than "${RETENTION_DAYS}d" "backup/$BACKUP_S3_BUCKET/postgres" >/dev/null 2>&1 || true
  mc rm --recursive --force --older-than "${RETENTION_DAYS}d" "backup/$BACKUP_S3_BUCKET/authentik" >/dev/null 2>&1 || true
  REMOTE_OK=true

  mirror_host="$(endpoint_host "$BACKUP_S3_ENDPOINT")"
  if [[ -z "${BACKUP_LOCAL_ADDRESSES:-}" ]]; then
    log "WARNING: BACKUP_LOCAL_ADDRESSES is unset, so the mirror at $mirror_host"
    log "WARNING: cannot be shown to be off-host. Declare the addresses of this host"
    log "WARNING: (docs/DisasterRecovery.md §2) or $mirror_host will keep alerting."
  else
    mirror_ips="$(resolve_ipv4 "$mirror_host")"
    if [[ -z "$mirror_ips" ]]; then
      log "WARNING: could not resolve the mirror host $mirror_host; not claiming off-host"
    else
      local_hit=false
      for ip in $mirror_ips; do
        for declared in ${BACKUP_LOCAL_ADDRESSES//,/ }; do
          [[ "$ip" == "$declared" ]] && local_hit=true
        done
      done
      if [[ "$local_hit" == true ]]; then
        log "WARNING: the mirror host $mirror_host resolves to $(tr '\n' ' ' <<<"$mirror_ips") —"
        log "WARNING: this host. These backups do not survive losing it."
      else
        MIRROR_OFFHOST=1
        log "mirror $mirror_host resolves to $(tr '\n' ' ' <<<"$mirror_ips") — off this host"
      fi
    fi
  fi
else
  if [[ "${BACKUP_REQUIRE_REMOTE:-false}" == "true" ]]; then
    log "Remote backup credentials are required but missing" >&2
    exit 1
  fi
  log "Remote S3 backup is disabled; retaining local backup files only."
  log "These files do not survive the loss of this host. Set BACKUP_S3_* to a store"
  log "on another host (docs/DisasterRecovery.md §2) and BACKUP_REQUIRE_REMOTE=true."
fi

log "Applying local retention of $RETENTION_DAYS days..."
find "$BACKUP_DIR" -type f \( -name 'db-*.dump' -o -name 'authentik-db-*.dump' \) \
  -mtime "+$RETENTION_DAYS" -delete
find "$BACKUP_DIR/minio" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -exec rm -rf {} +

log "Backup stored in $BACKUP_DIR"
ls -lh "$BACKUP_DIR" | head -20
