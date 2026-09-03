#!/bin/sh
set -eu

run_backup() {
  /bin/bash /backup/backup.sh >> /backup-cache/backup.log 2>&1
}

if [ "${BACKUP_ONCE:-false}" = "true" ]; then
  echo "[backup] running a single backup..."
  run_backup
  exit 0
fi

if [ "${BACKUP_RUN_ON_START:-true}" = "true" ]; then
  echo "[backup] running startup backup..."
  run_backup || echo "[backup] startup backup failed; scheduled run will retry" >&2
fi

interval="${BACKUP_INTERVAL_SECONDS:-86400}"
case "$interval" in
  ''|*[!0-9]*) echo "BACKUP_INTERVAL_SECONDS must be a positive integer" >&2; exit 1 ;;
  0) echo "BACKUP_INTERVAL_SECONDS must be greater than zero" >&2; exit 1 ;;
esac

echo "[backup] scheduling backups every ${interval}s"
while :; do
  sleep "$interval"
  run_backup || echo "[backup] scheduled backup failed; retrying at next interval" >&2
done
