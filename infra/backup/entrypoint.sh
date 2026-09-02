#!/bin/sh
# ==========================================================================
# Backup container entrypoint: installs tooling, then runs backup.sh on a
# cron schedule. Also runs in a loop for readiness-based orchestration.
# ==========================================================================
set -eu

if [ "$(id -u)" -eq 0 ]; then
  echo "[backup] installing tools..."
  apk add --no-cache postgresql-client curl tzdata >/dev/null 2>&1 || true
  if [ -n "${S3_ACCESS_KEY:-}" ]; then
    curl -sfL "https://dl.min.io/client/mc/release/linux-amd64/mc" -o /usr/local/bin/mc
    chmod +x /usr/local/bin/mc
  fi
fi

CRON_SCHEDULE="${BACKUP_CRON:-0 2 * * *}"

if [ "${BACKUP_ONCE:-}" = "true" ]; then
  echo "[backup] running a single backup..."
  /backup/backup.sh
  exit 0
fi

echo "[backup] scheduling with cron: $CRON_SCHEDULE"
shift 2>/dev/null || true
echo "$CRON_SCHEDULE /bin/sh /backup/backup.sh >> /backup-cache/backup.log 2>&1" > /etc/crontabs/root
crond -f -l 2