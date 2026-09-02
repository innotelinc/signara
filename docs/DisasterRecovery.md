# Signara — Disaster Recovery

## 1. Objectives

| Metric | Target | Notes |
| --- | --- | --- |
| RPO (Recovery Point Objective) | ≤ 24 h | default schedule: daily 02:00 UTC |
| RTO (Recovery Time Objective) | ≤ 4 h | recreate stack from compose/k8s + restore |
| Backup retention | 30 days local + long-term archive | tune `BACKUP_RETENTION_DAYS` |

## 2. What is backed up

| Asset | Method | Location |
| --- | --- | --- |
| PostgreSQL (all tables) | `pg_dump -Fc` (custom) | `infra/backup/backup.sh` → `/backup-cache` → optional S3 mirror |
| MinIO objects (documents, signature images, template files) | `mc mirror` | same job; enable MinIO bucket versioning |
| Configuration | `.env`, `docker-compose*.yml`, `infra/`, `openapi/` | git (repository is the source of truth) |
| Authentik (IdP) | its own backups | configure separately — identity metadata matters (see § 5) |

The backup container (`docker-compose.prod.yml` → `backup` service) runs
`backup.sh` on a cron schedule and records Prometheus-exportable status files
used by the `BackupJobFailed` / `BackupStale` alerts.

## 3. Restore playbook

### Restore the database (latest dump)

```bash
docker compose -f docker-compose.prod.yml exec backup /backup/restore.sh
# or pick a specific point in time:
docker compose -f docker-compose.prod.yml exec backup /backup/restore.sh /backup-cache/db-20260901T020000Z.dump
```

### Restore objects (MinIO → S3)

```bash
docker compose -f docker-compose.prod.yml exec backup mc mirror \
  backup/<bucket>/objects/<timestamp> local/minio
```

### Full recovery of an instance

1. Provision a fresh host/cluster (see Deployment.md).
2. `git clone` the repo, restore `.env` from your vault.
3. `./setup.sh` — builds the stack and applies migrations.
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

| Secret | Rotation |
| --- | --- |
| `CRYPTO_MASTER_KEY` | re-encrypt affected columns; require application restart. Rotate by setting a new value and running the re-key job (WIP). |
| JWT access/refresh secrets | rotate → all sessions invalid on next refresh (refresh cookies use the old secret — issue a forced re-login if immediate revocation is needed). |
| OIDC client secret | rotate in Authentik + `.env`; no user impact besides a new token. |
| MinIO credentials | rotate in MinIO console + `.env`; restart API (`api` reads at boot). |
| Postgres/Redis passwords | rotate in `.env` + service config, restart the stack members. |

## 7. Runbooks

### API 5xx spike (alert `ApiHighErrorRate`)

1. `loki` — tail `api` logs for 5xx + stack traces; correlate `requestId`.
2. `kubectl get pods -n signara` / `docker ps` — check for OOM-restarts.
3. Check Postgres (connection count, slow queries), Redis (queue backlog).
4. Mitigate: scale replicas (HPA), restart the API deployment,
   `kubectl rollout restart deployment/api`.

### Queue failures (alert `QueueFailuresHigh`)

1. Check workers are up (`QueueWorkerDown` red?).
2. `bullmq` dashboard or redis keys — inspect failed job payloads
   (SMTP credentials misconfigured is the top cause).
3. Retry failed jobs via the queue UI/CLI; fix the root cause first.

### Object storage down (alert `StorageEndpointDown`)

1. MinIO container/pod status; disk space (`StorageAlmostFull`?).
2. API uploads/downloads already return 503s — signing fails at presign.
3. Restore MinIO from the last backup mirror if data volume is corrupt.

### Backup failure (alert `BackupJobFailed` / `BackupStale`)

1. `docker compose ... exec backup cat /backup-cache/backup.log`.
2. Common causes: Postgres credentials rotated, S3 endpoint unreachable,
   disk full on the backup volume.
3. Re-run manually: `docker compose -f docker-compose.prod.yml exec backup /backup/backup.sh`.

### Certificate expiry (alert `CertificateExpiringSoon`)

1. Check cert-manager/NPM renewal logs.
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