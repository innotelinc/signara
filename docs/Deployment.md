# Signara — Deployment Guide

Deployment options, in increasing order of scale:

1. [Docker Compose (single host)](#1-docker-compose-single-host)
2. [Kubernetes (enterprise / HA)](#2-kubernetes-enterprise)
3. [DNS & TLS via NGINX Proxy Manager](#3-dns--tls-nginx-proxy-manager)
4. [Identity provider (Authentik) setup](#4-identity-provider-authentik)
5. [Certificate-backed signing (PKI providers)](#5-certificate-backed-signing-pki-providers)
6. [Post-deploy checklist](#6-post-deploy-checklist)

---

## 1. Docker Compose (single host)

### Prerequisites

- Docker 24+ with the compose v2 plugin
- 8 GB RAM, 4 vCPU (recommended), ~60 GB disk
- DNS records (see § 3)

### Steps

```bash
git clone <repo-url> signara && cd signara

# 1. Provision: validates prerequisites, generates .env with strong secrets,
#    starts infra, migrates + seeds the DB.
./setup.sh

# 2. (Optional) Auth via Authentik running on the same host:
#    finish the provider in § 4, then update .env OIDC_* values.

# 3. Start the production stack
docker compose -f docker-compose.prod.yml up -d --build

# 4. Verify
curl https://api.signara.innotel.us/ready   # {"status":"ok",...}
```

### Operations

| Task | Command |
| --- | --- |
| View status | `docker compose -f docker-compose.prod.yml ps` |
| Logs | `docker compose -f docker-compose.prod.yml logs -f api` |
| Upgrade | `git pull && ./setup.sh && docker compose -f docker-compose.prod.yml up -d --build` |
| Backup | `docker compose -f docker-compose.prod.yml exec backup /backup/backup.sh` |
| Restore | `docker compose -f docker-compose.prod.yml exec backup /backup/restore.sh <file>` |
| Metrics | `curl localhost:9090` (Prometheus), Grafana on `:3001` |

### Resource limits & health checks

Every service declares CPU/memory limits and startup/readiness probes
(`healthcheck:` in compose; `readinessProbe`/`livenessProbe` in K8s). The API
cannot serve traffic until Postgres, Redis, MinIO, and Meilisearch are healthy.

## 2. Kubernetes (enterprise)

### Prerequisites

- Cluster with an ingress controller (nginx) and cert-manager
- StorageClass supporting `ReadWriteOnce` PVCs
- Namespace enforced with a Pod Security standard (restricted)

### Deploy

```bash
# 1. Apply secrets from your vault (never the example file)
kubectl create namespace signara
kubectl create secret generic signara-secrets -n signara --from-env-file=.env

# 2. Apply the kustomized base
kubectl apply -k infra/kubernetes/base

# 3. Roll out state
kubectl rollout status deployment/api -n signara
kubectl rollout status deployment/web -n signara

# 4. Wire DNS + TLS
#    Point app/api/auth/docs records at the ingress; cert-manager issues
#    certificates automatically from the ClusterIssuer referenced in
#    infra/kubernetes/base/ingress.yaml.
```

### High availability notes

- **API/Web**: 2+ replicas, rolling updates (maxUnavailable 0), HPA scales to
  N based on CPU/memory (`hpa.yaml`).
- **Postgres**: single-node StatefulSet out of the box. For HA run managed
  Postgres (RDS/Cloud SQL) or Patroni with a service that exposes one write
  target; update `DATABASE_URL` in the ConfigMap.
- **Redis**: single-node for queues. For prod, configured with AOF; consider
  Redis Sentinel/managed Redis for durability.
- **MinIO**: single-node with a large PVC; scale to distributed MinIO
  (erasure coding) or managed S3 for higher durability. Bucket versioning
  recommended.
- **Loki/Alertmanager/Prometheus**: single-binary; scale Grafana Loki with
  object-store backend when retention needs grow.

## 3. DNS & TLS (NGINX Proxy Manager)

The automation (`infra/nginx/npm-proxy-hosts.py`) creates the proxy hosts and
requests the wildcard certificate. Hooked into `setup.sh --with-nginx`.

| Subdomain | Backend |
| --- | --- |
| `app.signara.innotel.us` | web :3000 |
| `api.signara.innotel.us` | api :8000 |
| `auth.signara.innotel.us` | authentik :9000 |
| `admin.signara.innotel.us` | NPM admin UI / admin app |
| `docs.signara.innotel.us` | docs site |

```bash
export NPM_API_URL=http://<npm-host>:81
export NPM_API_TOKEN=<token>
export CF_API_TOKEN=<cloudflare-dns-token>   # wildcard DNS-01
export LETSENCRYPT_EMAIL=admin@signara.innotel.us
python3 infra/nginx/npm-proxy-hosts.py --apply
```

What the script sets on every host: HTTPS-only (301 redirect), HSTS preload,
security headers (CSP-compatible set in Security.md), WebSocket support for the
app, and blocking of common exploits. Certificates auto-renew via NPM.

DNS records (point to the NPM host public IP):

```
*.signara.innotel.us    A  <npm-host-ip>
app.signara.innotel.us  A  <npm-host-ip>      (or CNAME *)
api.signara.innotel.us  A  <npm-host-ip>
auth.signara.innotel.us A  <npm-host-ip>
admin.signara.innotel.us A <npm-host-ip>
docs.signara.innotel.us A  <npm-host-ip>
```

## 4. Identity provider (Authentik)

Deployed by the compose file. Bootstrap:

1. Open `http(s)://auth.signara.innotel.us` (or `http://<host>:9100` in dev),
   log in with `AUTHENTIK_BOOTSTRAP_EMAIL`/`AUTHENTIK_BOOTSTRAP_PASSWORD` from
   `.env`.
2. **Application** → create provider **OIDC**:
   - Client ID: `signara-web`, Client Secret: value from `.env` (`OIDC_CLIENT_SECRET`)
   - Redirect URIs: `https://app.signara.innotel.us/api/auth/callback`
   - Signing key: RS256, issuer must match `OIDC_ISSUER_URL`
3. Create the **application** bound to the provider; assign the default flows.
4. **Groups**: create `signara-admins` (maps to `PLATFORM_ADMIN`) and assign
   users; group names flow into the token `groups` claim.
5. MFA: enable the MFA flow stage (TOTP/WebAuthn) on the authentication flow.
6. Update Signara `.env`:
   `OIDC_ISSUER_URL`, `OIDC_JWKS_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
   `OIDC_REDIRECT_URI`, `OIDC_AUTHORIZATION_URL`, `OIDC_TOKEN_URL`,
   `OIDC_USERINFO_URL` — then restart the API.

**SAML/SCIM**: Authentik exposes a SAML provider (IdP metadata endpoint) and a
SCIM provisioning API; enable in the Authentik UI and map user/group sync to
Signara's `User.email` ↔ `Membership`.

## 5. Certificate-backed signing (PKI providers)

The certificates module supports ACME, Cerulean, and Internal PKI providers.
Private key material is encrypted at rest with `CRYPTO_MASTER_KEY` (AES-256-GCM)
— it must be set in `.env` (Compose) or the Secret (K8s) and never rotated
without re-encrypting `SigningCertificate.privateKeyEnc` rows.

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `CRYPTO_MASTER_KEY` | always (for cert signing) | master secret for key-at-rest encryption |
| `CERT_PROVIDER_ACME_DIRECTORY` | ACME only | ACME directory URL (e.g. `https://acme-v02.api.letsencrypt.org/directory`) |
| `CERT_PROVIDER_ACME_EMAIL` | ACME only | account contact for ACME registration |
| `CERT_PROVIDER_CERULEAN_BASE_URL` | Cerulean only | Cerulean instance URL |
| `CERT_PROVIDER_CERULEAN_API_TOKEN` | Cerulean only | Cerulean API token |

Status: `GET /api/v1/certificates/providers` reports which providers are
configured for the deployment. Provisioning a certificate for an unconfigured
provider returns a clear 400 instead of a silent failure.

### ACME

```bash
CERT_PROVIDER_ACME_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory
CERT_PROVIDER_ACME_EMAIL=admin@signara.innotel.us
```

`POST /api/v1/certificates/provision` with `provider: "ACME"` and an email
common name. The provider requests a certificate (DNS-01 challenge preferred
for email-bound identities) and stores the key encrypted. Requires outbound
443 access to the ACME directory.

### Cerulean

```bash
CERT_PROVIDER_CERULEAN_BASE_URL=https://cerulean.example.com
CERT_PROVIDER_CERULEAN_API_TOKEN=<token>
```

Cerulean holds the private keys. Sign with
`{ "type": "CERTIFICATE", "certificateId": … }` and pass `signatureValue`
from the Cerulean API; Signara verifies it against the stored certificate
public key before recording the signature.

### Internal PKI / enterprise CA

`POST /api/v1/certificates/import` with the certificate PEM and (optionally) a
private key PEM. The key is proven to match (sign/verify round-trip) and then
encrypted at rest. When only the certificate is imported, signatures must
supply `signatureValue` from the signing service that holds the key.

### Email (SMTP)

Signing invitations, reminders, and notification emails are delivered by the
`signing` and `notifications` workers over SMTP (nodemailer). Configure in
`.env`: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE` (`true` for implicit TLS on
465; default STARTTLS on 587), `SMTP_USER`/`SMTP_PASS` (optional), and
`SMTP_FROM`. When `SMTP_HOST` is unset the workers record state without
sending, so local development needs no mail server. Transport failures are
retried by BullMQ with exponential backoff and surfaced as failed
notifications / alert rules (`signara_queue_failures`).

## 6. Post-deploy checklist

- [ ] `https://api.signara.innotel.us/ready` returns ok
- [ ] OIDC login round-trip works (MFA enforced)
- [ ] Upload PDF → create signing request → sign via emailed link
- [ ] Evidence report renders with events + hashes
- [ ] Prometheus scrapes `/metrics`; Grafana shows the overview dashboard
- [ ] Backup job ran successfully (`signara_backup_last_status 1`)
- [ ] Smoke test workflow passed (`.github/workflows/smoke-test.yml`)