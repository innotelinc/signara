# Signara - Deployment Guide

This guide documents the supported Docker Compose deployment for a self-hosted
Signara installation, plus optional NGINX Proxy Manager automation.

1. [Docker Compose](#1-docker-compose)
2. [DNS, TLS, and NGINX via Cerulean](#2-dns-tls-and-nginx-via-cerulean)
3. [Legacy direct NGINX automation](#3-legacy-direct-nginx-automation)
4. [Identity provider (Authentik)](#4-identity-provider-authentik)
5. [Certificate-backed signing](#5-certificate-backed-signing)
6. [Post-deploy checklist](#6-post-deploy-checklist)

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

The development stack exposes the web UI on `http://localhost:3000`, the API
on `http://localhost:8000`, Authentik on `http://localhost:9100`, MinIO on
`http://localhost:9001`, Prometheus on `http://localhost:9090`, and Grafana on
`http://localhost:3001`.

### Production

```bash
git clone <repo-url> signara && cd signara
./setup.sh --production
```

`setup.sh --production` validates prerequisites, creates missing local secrets,
starts the production dependencies, applies migrations inside the Compose
network, and starts the stack. Add `--use-images` on a deployment host to pull
published GHCR images instead of building API and web locally. Add
`--with-cerulean` to reconcile DNS, NGINX Proxy Manager hosts, and TLS through
Cerulean. DNS uses the persisted public WAN IP; NPM uses the host LAN IP.

### Operations

| Task          | Command                                                                           |
| ------------- | --------------------------------------------------------------------------------- |
| View status   | `docker compose -f docker-compose.prod.yml ps`                                    |
| API logs      | `docker compose -f docker-compose.prod.yml logs -f api`                           |
| Upgrade       | `git pull && ./setup.sh --production --use-images --image-tag=sha-TAG`            |
| Backup        | `docker compose -f docker-compose.prod.yml exec backup /backup/backup.sh`         |
| Restore       | `docker compose -f docker-compose.prod.yml exec backup /backup/restore.sh <file>` |
| Stop services | `docker compose -f docker-compose.prod.yml down`                                  |
| Metrics       | Prometheus on `:9090`, Grafana on `:3001`                                         |

All Compose services include health checks, restart policies, resource limits,
and bounded JSON logging. The API waits for PostgreSQL, Redis, MinIO, and
Meilisearch before becoming ready.

### Backups

The production stack includes a backup container for PostgreSQL, Authentik, and
MinIO objects. Each run writes database dumps and a MinIO archive to the persistent
`backupcache` volume. Configure all `BACKUP_S3_*` variables for an off-host mirror,
set `BACKUP_REQUIRE_REMOTE=true` when remote durability is mandatory, and tune
`BACKUP_RETENTION_DAYS`. Run restore drills regularly; see
[DisasterRecovery.md](DisasterRecovery.md).

## 2. DNS, TLS, and NGINX via Cerulean

Cerulean is the recommended automation path. It owns the DNS record updates,
NGINX Proxy Manager reconciliation, wildcard certificate issuance/renewal, and
certificate attachment. DNS A records for Signara hosts always use the public
WAN IPv4 address. NPM upstreams use the host LAN IPv4 address so NPM can reach
the API, web, Authentik, and admin ports; Docker bridge addresses are rejected.
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
make cerulean:provision
```

The checked-in map at `infra/cerulean/hosts.conf` provisions:

| Hostname | DNS A record | NPM upstream |
| --- | --- | --- |
| `app.signara.innotel.us` | WAN IP | LAN IP `:3000` |
| `api.signara.innotel.us` | WAN IP | LAN IP `:8000` |
| `auth.signara.innotel.us` | WAN IP | LAN IP `:9100` |
| `admin.signara.innotel.us` | WAN IP | LAN IP `:81` |

On every normal provisioning run, Cerulean redetects and validates the current
public WAN IPv4, persists it as `CERULEAN_WAN_IP`, and uses it for DNS. Cerulean
then registers or reuses the `innotel.us` zone, removes prior A/CNAME
records at the four exact Signara hostnames, creates exactly one WAN A record
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

| Hostname                   | Backend                                              |
| -------------------------- | ---------------------------------------------------- |
| `app.signara.innotel.us`   | web `:3000`                                          |
| `api.signara.innotel.us`   | api `:8000`                                          |
| `auth.signara.innotel.us`  | Authentik host port `:9100` (container port `:9000`) |
| `admin.signara.innotel.us` | NPM admin UI or administration app                   |

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

## 6. Post-deploy checklist

- [ ] `https://api.signara.innotel.us/ready` returns a healthy response
- [ ] OIDC login round-trip works with MFA
- [ ] PDF upload and document download work
- [ ] Sequential and parallel signing flows complete
- [ ] Evidence reports include hashes, timestamps, and audit events
- [ ] Prometheus and Grafana receive metrics
- [ ] Backup job completes and a restore drill is recorded
- [ ] NGINX Proxy Manager certificates renew successfully
