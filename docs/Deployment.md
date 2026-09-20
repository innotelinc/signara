# Signara - Deployment Guide

This guide documents the supported operator-run Docker Compose deployment for a
self-hosted Signara installation, plus optional NGINX Proxy Manager automation.
GitHub Actions do not connect to or deploy the host.

1. [Docker Compose](#1-docker-compose)
2. [DNS, TLS, and NGINX via Cerulean](#2-dns-tls-and-nginx-via-cerulean)
3. [Legacy direct NGINX automation](#3-legacy-direct-nginx-automation)
4. [Identity provider (Authentik)](#4-identity-provider-authentik)
5. [Certificate-backed signing](#5-certificate-backed-signing)
6. [Post-setup checklist](#6-post-setup-checklist)

---

## 1. Docker Compose

### Prerequisites

- Docker 24+ with the Compose v2 plugin
- 8 GB RAM and 4 vCPU recommended
- 60 GB disk recommended, plus storage for documents and backups
- DNS records pointing the public hostnames at your reverse proxy

### Development

```bash
cp .env.example .env
npm install
./setup.sh
docker compose -f docker-compose.dev.yml up -d --build
```

The development stack exposes the web UI on `http://localhost:3010`, the API
on `http://localhost:8010`, Authentik on `http://localhost:9110`, MinIO on
`http://localhost:9005` (console `:9006`), Prometheus on
`http://localhost:9091`, and Grafana on `http://localhost:3007`.

Dev published ports are deliberately disjoint from the shared production
stack (which owns `:3000/:8000/:9000/:9002/:5432/:6379/:7700` and friends) so
the dev and prod stacks can run on the same host without port collisions.

### Production

```bash
git clone https://github.com/innotelinc/signara.git signara
cd signara
cp .env.example .env
# Edit .env and set production secrets and public URLs.
./setup.sh --production
```

`setup.sh --production` validates prerequisites, creates missing local secrets,
starts the production dependencies, applies migrations inside the Compose
network, and starts the stack. Add `--use-images` when you intentionally want to pull published GHCR images instead
of building API and web locally. Add
`--with-cerulean` to reconcile DNS, NGINX Proxy Manager hosts, and TLS through
Cerulean. DNS uses the persisted public WAN IP; NPM uses the host LAN IP.

The browser-facing entry points come from `.env`: `WEB_URL`/`APP_URL` (the web
app), `API_URL`, and `AUTH_URL`. Presigned document URLs are signed against
`S3_PUBLIC_ENDPOINT` (e.g. `https://storage.signara.innotel.us`) so browsers can
reach object storage directly instead of through the API. Since the cutover that
object storage is the estate's `onyx-objectstore`, and the `SIGNARA_S3_*`
variables in `.env` select it — see “Storage profile” below. The API derives its
CORS allowlist from `WEB_URL`/`APP_URL` — including the apex/parent domain of
those hosts and `localhost:3000` for development — and only needs
`CORS_ORIGINS` when an extra origin must be allowed.

### Operations

| Task          | Command                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| View status   | `docker compose -f docker-compose.prod.yml ps`                                    |
| API logs      | `docker compose -f docker-compose.prod.yml logs -f api`                           |
| Upgrade       | `git pull && ./setup.sh --production`                                             |
| Backup        | `docker compose -f docker-compose.prod.yml exec backup /backup/backup.sh`         |
| Restore       | `docker compose -f docker-compose.prod.yml exec backup /backup/restore.sh <file>` |
| Stop services | `docker compose -f docker-compose.prod.yml down`                                  |
| Metrics       | Prometheus on `:9090`, Grafana on `:3001`                                         |

All Compose services include health checks, restart policies, resource limits,
and bounded JSON logging. The API waits for PostgreSQL, Redis, and Meilisearch
before becoming ready — deliberately **not** on the object store, so that the
retired store can be stopped without the API refusing to boot.

### Storage profile

Documents live in an S3-compatible store selected entirely from `.env`. Moving
stores is a configuration change, not a code change.

| Variable                                          | Purpose                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `SIGNARA_S3_ENDPOINT`                             | Where the API reads and writes. Currently `http://172.17.0.1:2090`. |
| `SIGNARA_S3_BUCKET`                               | Bucket holding document objects (default `signara-documents`).      |
| `SIGNARA_S3_ACCESS_KEY` / `SIGNARA_S3_SECRET_KEY` | Credentials for that store.                                         |
| `SIGNARA_S3_PUBLIC_ENDPOINT`                      | Host that browser-facing presigned URLs are signed for.             |

`S3_*` **without** the prefix is a different thing: MinIO's own root credentials,
left untouched so the retired store can be started again for a rollback. Compose
maps `SIGNARA_S3_*` onto the `S3_*` names the API reads, and `environment` wins
over `env_file`.

To move stores — copy first, which verifies every object byte for byte before
anything is pointed at it:

```bash
SOURCE_S3_ENDPOINT=http://…:9002 SOURCE_S3_ACCESS_KEY=… SOURCE_S3_SECRET_KEY=… \
TARGET_S3_ENDPOINT=http://…:2090 TARGET_S3_ACCESS_KEY=… TARGET_S3_SECRET_KEY=… \
  node scripts/migrate-object-store.mjs --apply
```

Then change `SIGNARA_S3_*` and run
`docker compose -f docker-compose.prod.yml -f docker-compose.override.prod.yml up -d --no-deps api`.
Verify the store itself with `scripts/onyx-objectstore-smoke.sh` (plain REST, no
client library in the way) and `scripts/onyx-s3-test.mjs` (a real S3 SDK); verify
the _browser_ path by presigning an object for `SIGNARA_S3_PUBLIC_ENDPOINT` and
fetching it through the edge, then comparing it to the document's
`checksumSha256`.

### Backups

The production stack includes a backup container for PostgreSQL, the identity
database, and the object store the API actually uses. Each run writes database
dumps and an object archive to the persistent `backupcache` volume. Configure all
`BACKUP_S3_*` variables for an off-host mirror and `BACKUP_RETENTION_DAYS` for
retention; set `BACKUP_REQUIRE_REMOTE=true` so a missing mirror **fails** the run
instead of downgrading it to local-only.

The identity database is dumped when `AUTHENTIK_POSTGRES_PASSWORD` is set, since
it is not part of every deployment: in this estate Authentik belongs to Cerulean,
and the production overlay joins that stack's network to reach it. Coverage is
reported as `signara_backup_identity_covered`, so a stack whose dumps contain no
logins says so instead of looking complete.

A mirror is required, not optional: the `backupcache` volume sits on the host whose
database it protects. Whether that mirror is _somewhere else_ is what
`signara_backup_mirror_offhost` reports and `BackupIsLocalOnly` alerts on —
`remote_enabled` says only that credentials were configured, and a mirror on the
same host reads as a success while adding no durability. Off-host is proven rather
than assumed: the job resolves the mirror endpoint and compares it against
`BACKUP_LOCAL_ADDRESSES`, which has to list this host's addresses. Object
transfers to and from the mirror use `rclone`, because ONYX refuses the streaming
SigV4 payloads `mc` sends for every PUT. Verify durability with
`scripts/restore-drill.sh` (Docker-only, non-destructive — it uses its own
throwaway containers) and record the run in [DisasterRecovery.md](DisasterRecovery.md) §4.

## 2. DNS, TLS, and NGINX via Cerulean

Cerulean is the recommended automation path. It owns the DNS record updates,
NGINX Proxy Manager reconciliation, wildcard certificate issuance/renewal, and
certificate attachment. DNS A records for Signara hosts always use the public
WAN IPv4 address. NPM upstreams use the host LAN IPv4 address so NPM can reach
the API, web, storage, Authentik, and admin ports; Docker bridge addresses are rejected.
The two addresses are deliberately separate.

Set these values in `.env`:

```bash
CERULEAN_DNS_API_URL=http://localhost:3003
CERULEAN_ADMIN_PASSWORD=<cerulean-admin-password>
CERULEAN_BASE_DOMAIN=signara.innotel.us
CERULEAN_ZONE=innotel.us
CERULEAN_LAN_IP=192.168.1.46   # NPM upstream only; replace with host LAN IPv4
CERULEAN_WAN_IP=73.68.203.71   # last verified WAN value; DNS only
CERULEAN_WAN_DISCOVERY_URL=https://api.ipify.org
```

Preview the reconciliation:

```bash
python3 infra/cerulean/provision.py --dry-run --dotenv .env
```

Apply it during setup or independently:

```bash
./setup.sh --production --with-cerulean
# or
make cerulean-provision
```

The checked-in map at `infra/cerulean/hosts.conf` provisions:

| Hostname                     | DNS A record | NPM upstream    |
| ---------------------------- | ------------ | --------------- |
| `app.signara.innotel.us`     | WAN IP       | LAN IP `:3000`  |
| `api.signara.innotel.us`     | WAN IP       | LAN IP `:8000`  |
| `auth.signara.innotel.us`    | WAN IP       | LAN IP `:9100`  |
| `admin.signara.innotel.us`   | WAN IP       | LAN IP `:81`    |
| `storage.signara.innotel.us` | WAN IP       | docker0 `:2090` |

`storage` backs the browser-facing presigned document URLs (`S3_PUBLIC_ENDPOINT`),
served by the estate's `onyx-objectstore`. It is reached on the docker0 gateway
(`172.17.0.1:2090`) because the store is deliberately not published on the LAN —
only the loopback address and the bridge gateway answer. It needs no WebSocket
support, so its `hosts.conf` entry is flagged `no`.

On every normal provisioning run, Cerulean redetects and validates the current
public WAN IPv4, persists it as `CERULEAN_WAN_IP`, and uses it for DNS. Cerulean
then registers or reuses the `innotel.us` zone, removes prior A/CNAME
records at the five exact Signara hostnames, creates exactly one WAN A record
per host, creates or updates the NPM hosts with LAN upstreams, and issues or
reuses the `*.signara.innotel.us` wildcard certificate. Unrelated records in
`innotel.us` are never removed. Certificate renewal and NPM attachment remain
managed by Cerulean.

## 3. Legacy direct NGINX automation

The direct script remains available for installations that do not run Cerulean.
It drives NPM directly and uses Cloudflare + Let's Encrypt DNS-01 credentials;
it does not enforce the Cerulean WAN-DNS/LAN-upstream workflow.

### DNS and TLS via NGINX Proxy Manager

The automation at `infra/nginx/npm-proxy-hosts.py` creates or updates proxy
hosts and can request the wildcard certificate. Run it directly or through
`./setup.sh --with-nginx`.

| Hostname                     | Backend                                                |
| ---------------------------- | ------------------------------------------------------ |
| `app.signara.innotel.us`     | web `:3000`                                            |
| `api.signara.innotel.us`     | api `:8000`                                            |
| `auth.signara.innotel.us`    | Authentik host port `:9100` (container port `:9000`)   |
| `admin.signara.innotel.us`   | NPM admin UI or administration app                     |
| `storage.signara.innotel.us` | onyx-objectstore `172.17.0.1:2090` (container `:9000`) |

```bash
export NPM_API_URL=http://<npm-host>:81
export NPM_API_TOKEN=<token>
export CF_API_TOKEN=<cloudflare-dns-token>
export LETSENCRYPT_EMAIL=admin@signara.innotel.us
python3 infra/nginx/npm-proxy-hosts.py --apply
```

The automation enables HTTPS redirects, HSTS, security headers, WebSocket
support, and certificate renewal through NGINX Proxy Manager.

For the legacy path only, DNS records should point at the NGINX Proxy Manager host:

```text
*.signara.innotel.us    A  <proxy-host-ip>
app.signara.innotel.us  A  <proxy-host-ip>
api.signara.innotel.us  A  <proxy-host-ip>
auth.signara.innotel.us A  <proxy-host-ip>
admin.signara.innotel.us A  <proxy-host-ip>
storage.signara.innotel.us A <proxy-host-ip>
```

## 4. Identity provider (Authentik)

Authentik runs as part of both Compose stacks.

1. Open `https://auth.signara.innotel.us`, or `http://<host>:9100` locally.
2. Sign in with `AUTHENTIK_BOOTSTRAP_EMAIL` and `AUTHENTIK_BOOTSTRAP_PASSWORD`.
3. Create an OIDC provider and an application named `signara-web`.
4. Set the redirect URI to `https://api.signara.innotel.us/api/v1/auth/callback`.
5. Configure the issuer, JWKS, authorization, token, and userinfo URLs in `.env`.
6. Create the `signara-admins` group for platform administrators.
7. Enforce MFA in the Authentik authentication flow.

Authentik also supports SAML and SCIM integrations for enterprise identity
lifecycle management; configure those through the Authentik administration UI.

### Login round-trip (app vs api host)

The web app lives on `app.<domain>` and the API on `api.<domain>`. The OIDC
callback runs on the API and must land the browser back in the **web app**, and
the session cookies must be visible on **both** subdomains so the app's
server-side `layout.tsx` can read `signara_access`:

- The callback redirects to `WEB_URL` (default `https://app.signara.innotel.us`)
  instead of a raw path on the API host (which returned a NestJS 404 page).
- Auth cookies (`signara_access`, `signara_refresh`, `signara_oidc_state`) are
  set with `Domain` derived from `API_URL` (e.g. `.signara.innotel.us`), so the
  app subdomain receives them. Set `COOKIE_DOMAIN` explicitly to override;
  leave empty for bare hosts/IPs (local dev).

Verify with a real browser: sign in at `https://app.signara.innotel.us` →
you land back on the dashboard, not an API error page.

## 5. Certificate-backed signing

The API supports ACME, Cerulean, and internal PKI providers. Private key
material is encrypted at rest with `CRYPTO_MASTER_KEY`; do not rotate that key
without re-encrypting existing certificate records.

Configure provider settings in `.env`, then use the certificate endpoints under
`/api/v1/certificates`. Provider-held keys remain outside Signara and imported
keys are verified against their certificates before storage.

SMTP configuration is optional in local development. Set `SMTP_HOST`,
`SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` to enable
invitation, reminder, and notification delivery.

## 6. Upgrading an existing deployment

Start by reading what is actually running, because the answer is not what the
tags suggest: **the deployment does not run images from the registry.** Both
`signara-api-1` and `signara-frontend-1` report no `RepoDigests`, and the
`ghcr.io/innotelinc/signara-api:latest` on the host was built there on 2026-09-08
— so it is a different artifact from the registry's `latest`, which CI pushes from
`main` and `v*`. Until one of the two routes below is chosen and applied, "the tag
names the build" is false on this host, and an upgrade is a rebuild, not a pull.

Pick one route and stay on it. Mixing them is how a host ends up running a build
nobody can name.

### 6.1 Host build (what is deployed today)

```bash
cd /usr/src/projects/complete/1-primary/signara
COMPOSE="docker compose -f docker-compose.prod.yml -f docker-compose.override.prod.yml"

# 1. Name what you are leaving behind, so rollback is a retag and not a rebuild.
docker tag ghcr.io/innotelinc/signara-api:latest signara-api:rollback-$(date +%Y%m%d)
docker tag ghcr.io/innotelinc/signara-web:latest signara-web:rollback-$(date +%Y%m%d)

# 2. Back up first. A migration is the one step a rollback cannot undo.
make backup

# 3. Code and images.
git pull --ff-only
$COMPOSE build api frontend migrate

# 4. Schema, then the long-running services.
$COMPOSE run --rm migrate           # prisma migrate deploy, once
$COMPOSE up -d --no-deps api frontend
```

### 6.2 Registry artifacts (pin what you run)

Set both images in `.env` and the upgrade becomes a pull:

```bash
SIGNARA_API_IMAGE=ghcr.io/innotelinc/signara-api:sha-<commit>
SIGNARA_WEB_IMAGE=ghcr.io/innotelinc/signara-web:sha-<commit>
```

CI publishes `sha-<commit>` for every build, version tags on `v*`, and a moving
`latest`. **Pin to `sha-<commit>` or a version tag, not `latest`:** pinning is what
makes "this deployment is running X" a claim `docker inspect` can check, and it is
what makes rollback a variable change rather than a rebuild. Then:

```bash
$COMPOSE pull api frontend migrate
$COMPOSE run --rm migrate
$COMPOSE up -d --no-deps api frontend
```

### 6.3 Migrations

- `migrate` runs `prisma migrate deploy` against the API image — the same schema
  the API expects, applied before the new API starts. Keep that order.
- Migrations are **forward-only**: Prisma has no down-migrations, so a bad one is
  undone by restoring the pre-upgrade dump, not by a reverse migration. That is
  why §6.1 runs the backup first, and why `BackupStale` is worth reading before
  an upgrade.
- Stop `api` and `frontend` (`$COMPOSE stop api frontend`) when a migration
  rewrites or drops data: a one-shot migration while the old API is serving is
  the state that produces half-migrated reads.
- Never `prisma migrate reset`, `db push` or `--force-reset` in production. They
  drop the database, and the dump is the only thing that would bring it back.

### 6.4 Verify, then record

1. `$COMPOSE ps` — `api`, `frontend`, `postgres`, `redis`, `meilisearch` healthy.
2. `curl -fsS https://api.signara.innotel.us/ready`.
3. `.github/workflows/smoke-test.yml` (signing round-trip through the edge).
4. After any schema change, run `scripts/restore-drill.sh --dump <fresh dump>` and
   record it in [DisasterRecovery.md](DisasterRecovery.md) §4. A rollback restores
   an _older_ dump into the current schema, and that is the path a drill proves.

### 6.5 Rolling back

Retag or re-point the two services and recreate them — `up -d --no-deps api
frontend` with the previous image ref — then repeat §6.4. Restore the dump **only**
if a migration was applied: restoring over a healthy database to undo an
application change loses every write since the dump for no reason.

## 7. Post-setup checklist

- [ ] `https://api.signara.innotel.us/ready` returns a healthy response
- [ ] OIDC login round-trip works with MFA
- [ ] PDF upload and document download work
- [ ] Sequential and parallel signing flows complete
- [ ] Evidence reports include hashes, timestamps, and audit events
- [ ] Prometheus and Grafana receive metrics
- [ ] Backup job completes and a restore drill is recorded
- [ ] NGINX Proxy Manager certificates renew successfully
