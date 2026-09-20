# Signara — Disaster Recovery

## 1. Objectives

| Metric                         | Target                            | Notes                                |
| ------------------------------ | --------------------------------- | ------------------------------------ |
| RPO (Recovery Point Objective) | ≤ 24 h                            | default schedule: daily 02:00 UTC    |
| RTO (Recovery Time Objective)  | ≤ 4 h                             | recreate the Compose stack + restore |
| Backup retention               | 30 days local + long-term archive | tune `BACKUP_RETENTION_DAYS`         |

## 2. What is backed up

| Asset                                                        | Method                                              | Location                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| PostgreSQL (all tables)                                      | `pg_dump -Fc` (custom)                              | `infra/backup/backup.sh` → `/backup-cache` → **off-host S3 mirror** (required for durability, §2) |
| Object storage (documents, signature images, template files) | `mc mirror` / `scripts/migrate-object-store.mjs`    | same job; enable bucket versioning on the target                                                  |
| Configuration                                                | `.env`, `docker-compose*.yml`, `infra/`, `openapi/` | git (repository is the source of truth)                                                           |
| Authentik (IdP)                                              | its own backups                                     | configure separately — identity metadata matters (see § 5)                                        |

The backup container (`docker-compose.prod.yml` -> `backup` service) runs
`backup.sh` at `BACKUP_INTERVAL_SECONDS` intervals and records Prometheus-exportable
status files used by the `BackupJobFailed` / `BackupStale` alerts. Every run keeps
PostgreSQL dumps and an object-storage archive on the `backupcache` volume;
configured remote S3 credentials add an off-host mirror. The archive follows the
storage profile (`SOURCE_S3_*` in the compose file), so it backs up whichever
store the API is actually using rather than naming one.

**Off-host is the requirement, not the option.** Backup files on `backupcache`
pass every freshness and completeness check while sitting on the same host as the
database they protect, and they die with it — which is how this estate lost a
platform's entire history (see `1-primary/sign/ARCHIVE.md` §8). So the two states
are reported separately: `signara_backup_last_success_timestamp` says a backup ran,
`signara_backup_remote_enabled` says a mirror is configured, and
`signara_backup_mirror_offhost` says that copy is on another machine — the only one
of the three that answers the question, and the one with the alert.

**Posture as of 2026-09-20: the mirror is configured and working — `BACKUP_S3_*`
points at ONYX's object store and `BACKUP_REQUIRE_REMOTE=true` makes a missing
mirror fail the run — but it fails the off-host test on purpose, because ONYX runs
on the deployment host itself. `signara_backup_mirror_offhost` is 0 and
`BackupIsLocalOnly` keeps firing; that alert is the remaining work, not a bug.**

**Off-host is decided by `signara_backup_mirror_offhost`, not by
`remote_enabled`.** "A mirror is configured" and "the mirror is somewhere else"
are different facts, and only the second survives losing the host — so the job
resolves the mirror endpoint and compares it against `BACKUP_LOCAL_ADDRESSES`,
the addresses that mean _this_ host, which the operator declares because a
container cannot see them. With those addresses undeclared, or the host
unresolvable, off-host is **not** claimed and the alert stays up: an unproven
claim of durability is the exact silence §1 is about.

**Why the mirror is written with `rclone` and not `mc`.** ONYX refuses streaming
SigV4 payloads — `onyx/services/objectstore/sigv4.go` answers 501 for a
`STREAMING-*` payload hash — and `mc` streams every PUT, so it cannot write to
ONYX at all: measured 2026-09-20, where every object failed with "streaming SigV4
payloads are not supported" while reads were fine. `rclone` signs plain payloads,
is the estate's S3 client of record (`onyx-objectstore` tiers buckets through it)
and ships with the distribution, so the backup image no longer downloads a client
at build time. Both directions use it, so the mirror cannot be written in a way it
cannot be read back.

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

```bash
scripts/restore-drill.sh                          # seed a database from this repo's migrations
scripts/restore-drill.sh --dump /path/to/prod.dump  # drill a real backup
scripts/restore-drill.sh --dump x.dump --keep       # leave the target running to poke at
```

Seed mode creates two throwaway Postgres containers, builds a source database from
this repo's own migrations, writes sentinel rows, backs it up with the same
`pg_dump -Fc` the job uses, restores it with the same `pg_restore --clean
--if-exists --exit-on-error` `restore.sh` uses, and then checks what actually came
back: row counts per table, the public-table count, a foreign-key join, and the
document checksum the completion certificate anchors on. Both containers are
removed afterwards, including on failure. It needs only Docker — so an operator
can drill a production dump from a laptop — and it refuses a dump that has no
Signara table data _before_ restoring, because a dump of the wrong database
restores perfectly and proves nothing.

**Drill record** — the exit criterion for workstream W6 is a dated entry here, not
a plan:

| Date       | Scope                                                                                                                                                                                                                  | Result                                                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-20 | Seed mode, `scripts/restore-drill.sh` on this repository                                                                                                                                                               | **PASS** — 4 migrations, 33 public tables, sentinel Organization/User/Workspace/Document rows all present after restore, workspace→organization join intact, document checksum `7f83b165…d9069` byte-identical, restore under 30 s                          |
| 2026-09-20 | Dump mode on that run's output (`sha256 bbddf68678357c44e4b241df2bc21f3432715a89a4abf54aea4a9cd391b236de`)                                                                                                             | **PASS** — 33 table-data entries restored, `_prisma_migrations` intact                                                                                                                                                                                      |
| 2026-09-20 | Dump mode against a non-Signara dump                                                                                                                                                                                   | **Refused, as intended** — fails with "carries no Organization table data" instead of reporting a clean restore                                                                                                                                             |
| 2026-09-20 | **Production dump, fetched from the ONYX mirror with `rclone`, drilled on the deployment host** (`db-20260920T021617Z.dump`, 118 848 bytes, `sha256 f2d4b983a9e065d73971ebfbcc17c6c891b1e60c3ae0405dc554058335019fec`) | **PASS** — 33 table-data entries restored into a throwaway Postgres, `_prisma_migrations` intact, content 3 organizations / 3 users / 12 documents / 105 audit rows. The mirror is therefore not just receiving bytes: a dump read back out of it restores. |

**What this does not prove.** The production drill above restores real data from
the mirror, so the restore path and the dump are measured rather than assumed. It
does **not** prove durability: the mirror lives on the same host as the database,
so the failure it protects against is a lost or corrupted object, a bad delete, or
a botched upgrade — not losing the machine. Workstream W6 stays open on exactly
one item: a mirror on another host (with `BACKUP_LOCAL_ADDRESSES` naming this one)
until `signara_backup_mirror_offhost` reads 1 and `BackupIsLocalOnly` clears. Until
then the RTO of ≤ 4 h is an estimate for anything that takes the host with it.

- **Monthly**: `.github/workflows/restore-drill.yml` runs seed mode on the first
  of the month and keeps its log as an artifact, so the path cannot rot quietly
  between operator drills. Add a row to the table only for drills with real data
  — CI has none to restore, which is the point of it being safe to run there.
- **Monthly (operator)**: rerun the drill above against a dump fetched from the
  mirror, on the deployment host, and add a row to the table.
- **Quarterly**: full instance burn-in on a scratch host, including signing a
  test envelope and generating an evidence report.

## 5. Identity provider continuity

Authentik holds your IdP state (users, groups, applications, flows). Back it up
alongside Signara:

- its PostgreSQL (`authentik-db`) via the same pg_dump approach;
- its config (blueprints) in git via Authentik's export/import.

On this deployment Authentik is **Cerulean's**, not this stack's: the backup
service joins Cerulean's network and dumps `cerulean-authentik-postgres` (see
`docker-compose.override.prod.yml`). Setting `AUTHENTIK_POSTGRES_PASSWORD` is what
switches that dump on, and `signara_backup_identity_covered` reports whether it is
on — 0 raises `IdentityDatabaseNotBackedUp`, because a restore that returns the
documents without the accounts that reach them is found on the day someone tries
to log in, not before. That cross-project credential is a coupling to remove when
Cerulean backs up its own identity database; until then, rotation of
`AUTHENTIK_POSTGRESQL_PASSWORD` in Cerulean's `.env` must be mirrored here.

If the IdP is lost but Signara's DB survives, users can authenticate again only
after re-provisioning Authentik users **with the same email addresses** —
Signara keys `User.authProviderId` by `sub`, and falls back to email matching
on login.

## 6. Secrets rotation runbook

| Secret                     | Rotation                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CRYPTO_MASTER_KEY`        | rotate only with a tested re-encryption procedure and application restart; retain the old key until verification completes.                                                                                                                                                                                |
| JWT access/refresh secrets | rotate → all sessions invalid on next refresh (refresh cookies use the old secret — issue a forced re-login if immediate revocation is needed).                                                                                                                                                            |
| OIDC client secret         | rotate in Authentik + `.env`; no user impact besides a new token.                                                                                                                                                                                                                                          |
| MinIO/object-store keys    | rotate in the store + `.env`; restart API (`api` reads at boot). **The backup mirror holds the same pair** — `BACKUP_S3_ACCESS_KEY`/`BACKUP_S3_SECRET_KEY` are set from `SIGNARA_S3_*` — so rotate both together, or the mirror alone starts failing (`BackupJobFailed`) while the application looks fine. |
| Postgres/Redis passwords   | rotate in `.env` + service config, restart the stack members.                                                                                                                                                                                                                                              |

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

### Backups are not leaving the host (alert `BackupIsLocalOnly`)

1. `docker compose -f docker-compose.prod.yml exec backup cat /backup-cache/status.prom`.
   `last_status 1` says the job is healthy; `signara_backup_mirror_offhost 0` says
   the durability is not. Read the two together — the mirror can be configured,
   current, and still on this host.
2. `mirror_offhost 0` has three causes, and the job's log names which:
   `BACKUP_S3_*` unset; the endpoint resolving to an address listed in
   `BACKUP_LOCAL_ADDRESSES`; or `BACKUP_LOCAL_ADDRESSES` unset, so off-host cannot
   be shown. The third looks like a false alarm until you set it — do not "fix" it
   by leaving the alert on and assuming the best.
3. The real fix is a target, not a rerun: point `BACKUP_S3_ENDPOINT`,
   `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY` and `BACKUP_S3_SECRET_KEY` at a store
   on a different host, keep `BACKUP_REQUIRE_REMOTE=true` so a missing mirror
   fails the run rather than downgrading it, and recreate the backup service.
   Credentials to copy, not guess: in this estate ONYX's own `.env` holds
   `vault://` references rather than keys, so use the literal ones the API holds.
4. Confirm the mirror actually holds the archive before trusting it, then run
   `scripts/restore-drill.sh` against a dump fetched from that store — the point
   of the mirror is that the restore path works from it, not that bytes arrived.

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
