# Signara — Disaster Recovery

## 1. Objectives

| Metric                         | Target                            | Notes                                |
| ------------------------------ | --------------------------------- | ------------------------------------ |
| RPO (Recovery Point Objective) | ≤ 24 h                            | default schedule: daily 02:00 UTC    |
| RTO (Recovery Time Objective)  | ≤ 4 h                             | recreate the Compose stack + restore |
| Backup retention               | 30 days local + long-term archive | tune `BACKUP_RETENTION_DAYS`         |

## 2. What is backed up

| Asset                                                       | Method                                              | Location                                                        |
| ----------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| PostgreSQL (all tables)                                     | `pg_dump -Fc` (custom)                              | `infra/backup/backup.sh` → `/backup-cache` → optional S3 mirror |
| Object storage (documents, signature images, template files) | `mc mirror` / `scripts/migrate-object-store.mjs`    | same job; enable bucket versioning on the target                |
| Configuration                                               | `.env`, `docker-compose*.yml`, `infra/`, `openapi/` | git (repository is the source of truth)                         |
| Authentik (IdP)                                             | its own backups                                     | configure separately — identity metadata matters (see § 5)      |

The backup container (`docker-compose.prod.yml` -> `backup` service) runs
`backup.sh` at `BACKUP_INTERVAL_SECONDS` intervals and records Prometheus-exportable
status files used by the `BackupJobFailed` / `BackupStale` alerts. Every run keeps
PostgreSQL dumps and an object-storage archive on the `backupcache` volume;
configured remote S3 credentials add an off-host mirror. The archive follows the
storage profile (`SOURCE_S3_*` in the compose file), so it backs up whichever
store the API is actually using rather than naming one.

## 3. Restore playbook

### Restore the database (latest dump)

```bash
docker compose -f docker-compose.prod.yml exec \
  -e CONFIRM_RESTORE=true backup /backup/restore.sh
# or pick a specific point in time:
docker compose -f docker-compose.prod.yml exec \
  -e CONFIRM_RESTORE=true backup /backup/restore.sh /backup-cache/db-20260901T020000Z.dump
```

### Restore objects (MinIO archive)

Set `OBJECT_TIMESTAMP` to the archive directory name, then run the restore script.
The script restores from the local `backupcache` archive; when that archive is
missing it falls back to the configured remote S3 mirror.

```bash
docker compose -f docker-compose.prod.yml exec \
  -e CONFIRM_RESTORE=true \
  -e OBJECT_TIMESTAMP=20260901T020000Z \
  backup /backup/restore.sh
```

### Full recovery of an instance

1. Provision a fresh host with Docker and Compose (see Deployment.md).
2. `git clone` the repo, restore `.env` from your vault.
3. `./setup.sh --production` — builds the stack and applies migrations.
4. Restore the database dump (§ above) — `pg_restore --clean` replaces content.
5. Restore objects, then verify checksums: compare `Document.checksumSha256`
   against the restored object (`mc stat` + `sha256sum`).
6. Run the smoke tests (`.github/workflows/smoke-test.yml`).

## 4. Verification drills

- **Monthly**: restore the latest dump into a scratch database
  (`createdb signara_drill && pg_restore -d signara_drill latest.dump`), run
  `prisma migrate status` and a count sanity script.
- **Quarterly**: full instance burn-in on a scratch host, including signing a
  test envelope and generating an evidence report.
- Record drill outcomes and keep the RTO estimate fresh.

## 5. Identity provider continuity

Authentik holds your IdP state (users, groups, applications, flows). Back it up
alongside Signara:

- its PostgreSQL (`authentik-db`) via the same pg_dump approach;
- its config (blueprints) in git via Authentik's export/import.

If the IdP is lost but Signara's DB survives, users can authenticate again only
after re-provisioning Authentik users **with the same email addresses** —
Signara keys `User.authProviderId` by `sub`, and falls back to email matching
on login.

## 6. Secrets rotation runbook

| Secret                     | Rotation                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `CRYPTO_MASTER_KEY`        | rotate only with a tested re-encryption procedure and application restart; retain the old key until verification completes.                     |
| JWT access/refresh secrets | rotate → all sessions invalid on next refresh (refresh cookies use the old secret — issue a forced re-login if immediate revocation is needed). |
| OIDC client secret         | rotate in Authentik + `.env`; no user impact besides a new token.                                                                               |
| MinIO credentials          | rotate in MinIO console + `.env`; restart API (`api` reads at boot).                                                                            |
| Postgres/Redis passwords   | rotate in `.env` + service config, restart the stack members.                                                                                   |

## 7. Runbooks

### API 5xx spike (alert `ApiHighErrorRate`)

1. `loki` — tail `api` logs for 5xx + stack traces; correlate `requestId`.
2. `docker compose -f docker-compose.prod.yml ps` — check service state and restarts.
3. Check Postgres (connection count, slow queries), Redis (queue backlog).
4. Mitigate by restarting the API service or increasing its Compose resource
   limits, then run `docker compose -f docker-compose.prod.yml restart api`.

### Queue failures (alert `QueueFailuresHigh`)

1. Check the API container is healthy; BullMQ processors run inside the API process.
2. Inspect the BullMQ dashboard or Redis keys for failed job payloads
   (SMTP credentials misconfigured is a common cause).
3. Retry failed jobs via the queue UI/CLI; fix the root cause first.

### Object storage down (alert `StorageEndpointDown`)

The store is the estate's `onyx-objectstore` (`SIGNARA_S3_ENDPOINT`), no longer a
bundled MinIO — see “Storage profile” in `docs/Deployment.md`.

1. Look on the **onyx-platform** deployment, not this one:
   `docker ps --filter name=onyx-objectstore`, plus its disk space
   (`StorageAlmostFull`). The API and the store are separate stacks, so "Signara
   is up" says nothing about the store.
2. API uploads and downloads return 503s, because signing fails at presign.
3. If the store's state volume is corrupt, restore the bucket from the last
   backup mirror — or fall back to MinIO, below.

### Storage rollback (back to bundled MinIO)

MinIO was stopped, not removed, and every object it held is still in its volume.
It now sits behind the `legacy-storage` profile:

```bash
cd /usr/src/projects/complete/1-primary/signara
docker compose -f docker-compose.prod.yml -f docker-compose.override.prod.yml \
  --profile legacy-storage up -d minio
# point SIGNARA_S3_* in .env back at MinIO — endpoint http://minio:9000, and the
# S3_ACCESS_KEY / S3_SECRET_KEY that were deliberately left unchanged
docker compose -f docker-compose.prod.yml -f docker-compose.override.prod.yml up -d --no-deps api
```

**Copy the objects back first, or you will lose them.** Everything written since
the cutover lives only in the Onyx store; MinIO's volume is a snapshot of the
moment it was demoted. Run `scripts/migrate-object-store.mjs` in the other
direction (`SOURCE_S3_*` = the store, `TARGET_S3_*` = MinIO) before trusting a
rollback. The `SIGNARA_S3_*` indirection exists so this is a config change: MinIO
keeps its own credentials throughout.

### Backup failure (alert `BackupJobFailed` / `BackupStale`)

1. `docker compose ... exec backup cat /backup-cache/backup.log`.
2. Common causes: Postgres credentials rotated, S3 endpoint unreachable,
   disk full on the backup volume.
3. Re-run manually: `docker compose -f docker-compose.prod.yml exec backup /backup/backup.sh`.

### Certificate expiry (alert `CertificateExpiringSoon`)

1. Check NGINX Proxy Manager renewal logs.
2. If DNS-01 credentials rotated, update `CF_API_TOKEN` and re-issue:
   `python3 infra/nginx/npm-proxy-hosts.py --cert-only`.
3. Verify: `curl -v https://app.signara.innotel.us 2>&1 | grep "expire date"`.

### Data corruption (signed documents mismatch checksum)

1. Quarantine the document (soft-delete).
2. Restore the object from the backup mirror; recompute SHA-256 and compare to
   `Document.checksumSha256`.
3. If the record itself is corrupt, restore the row from the DB dump and
   reconcile with the audit trail.

## 8. Contact & escalation

Document on-call contacts and escalation paths here (per deployment). Alert
routing: `infra/monitoring/alertmanager/alertmanager.yml`.

```

```
