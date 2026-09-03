# Signara — Administration Guide

For platform administrators (`PLATFORM_ADMIN`) and organization
owners/administrators.

## 1. Roles & permissions

### Platform roles

| Role             | Scope                         | Grants                                               |
| ---------------- | ----------------------------- | ---------------------------------------------------- |
| `USER`           | platform-wide least privilege | default for everyone                                 |
| `PLATFORM_ADMIN` | all tenants                   | `/admin/*`, cross-tenant metrics, suspend orgs/users |

`PLATFORM_ADMIN` is derived from the Authentik group `signara-admins` (token
`groups` claim; configurable via `IDP_ADMIN_GROUP`).

### Organization roles

| Role      | Typical duties                             |
| --------- | ------------------------------------------ |
| `OWNER`   | everything in the org; cannot be removed   |
| `ADMIN`   | org settings, members, billing             |
| `MANAGER` | send documents, manage templates, teams    |
| `AUDITOR` | read-only + audit export, evidence reports |
| `MEMBER`  | upload/sign personal documents             |

Fine-grained **permission codes** (seeded in `packages/database/prisma/seed.ts`)
are attached to roles via `Role → RolePermission → Permission`. Custom
organization roles can be created by extending the seed or the admin API.

## 2. Tenant isolation

- Hierarchy: **Organization → Workspace → Team**.
- Every tenant object is scoped by `organizationId`; the API guards this at
  three layers (see Architecture.md § 2).
- Workspace visibility: `PRIVATE` (only members), `TEAM` (team members),
  `ORGANIZATION` (all org members).
- Suspending a tenant (`PATCH /api/v1/admin/organizations/{id}/status`)
  immediately revokes all its sessions; users re-authenticate and are denied
  until reactivated.

## 3. Members & teams

- Invite: `POST /users/invite` (role + workspaces). Users authenticate via
  Authentik; until their first login their status is `INVITED`.
- First login auto-provisions the local `User` and activates the membership.
- Promote/demote: `PATCH /users/{id}/role` (OWNER/ADMIN only, and you may not
  demote the sole owner).
- Remove: `DELETE /users/{id}` (cannot remove the owner).
- Teams group members for shared routing and workspace permissions.

## 4. Billing administration

Plans: `Community`, `Professional`, `Business`, `Enterprise` (seeded in
`Plan`, prices in cents). Billing is pluggable:

- `BILLING_ENABLED=false` (default, self-hosted): local subscriptions,
  invoices, and coupon redemption are managed entirely by Signara — ideal for
  internal deployments that bill their own tenants out-of-band.
- `BILLING_ENABLED=true` + Stripe keys: the `createSubscription` flow delegates
  checkout to Stripe (`providerSubscriptionId`), webhooks keep status
  current; wire `stripeWebhookSecret` → a `/billing/webhooks` handler.

Usage metering is available via `GET /billing/usage` (documents, completed
requests, seats within the current period) — use it as input to invoicing
features or UI displays.

## 5. Security administration

- Force re-auth of a tenant/user: suspend, then reactivate (revokes sessions).
- API keys: `POST /api-keys` (name, scopes, optional expiry). The key is
  returned exactly once; revocation is immediate. Scope keys to the minimum
  permission codes (`documents.read`, `signing.send`, …).
- Rate limits: tune `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` per deployment;
  consider tightening login-scoped limits further.
- Secrets: see Security.md § 6 (environment file permissions, host secret manager, rotation).

## 6. Escalations & reminders

- `POST /signatures/requests/{id}/remind` — reminder per signer, max 1/24h.
- Escalation policies: extend `WorkflowRule` (`NOTIFY`/`REQUIRE`) to route to
  managers when a deadline approaches; the `signing` queue processor is the
  natural hook. Document your policy in the platform settings (`Setting`).

## 7. Observability for admins

| Tool         | Where                                       | Use                                       |
| ------------ | ------------------------------------------- | ----------------------------------------- |
| Grafana      | `monitoring./signara.innotel.us` (or :3001) | dashboards: API, queues, storage, backups |
| Prometheus   | :9090                                       | query & rule evaluation                   |
| Alertmanager | :9093                                       | routes alerts (email/Slack/PagerDuty)     |
| Loki         | :3100                                       | log search (correlate by `requestId`)     |

Alerts to monitor (rules in `infra/monitoring/prometheus/rules.yml`):
API 5xx > 5%, queue failure rate > 10%, certificate < 14 days, storage > 85%,
backup failed/stale > 36 h, Postgres down/connection saturation.

## 8. Managing certificates (signing PKI)

Certificate-backed signatures require the certificates module
(`apps/api/src/modules/certificates`) and `CRYPTO_MASTER_KEY` (private keys are
AES-256-GCM encrypted at rest).

### 8.1 Importing a certificate (Internal PKI / enterprise CA)

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "certificatePem": "-----BEGIN CERTIFICATE-----…",
        "privateKeyPem": "-----BEGIN PRIVATE KEY-----…",   # optional
        "provider": "INTERNAL_PKI",
        "validationLevel": "OV"
      }' \
  /api/v1/certificates/import
```

The private key is verified against the certificate before it is stored
encrypted. Re-importing the same serial reactivates the row (useful after
renewal).

### 8.2 Provisioning via ACME

Configure the ACME directory + account in `.env` (see `Deployment.md`):

```bash
CERT_PROVIDER_ACME_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory
CERT_PROVIDER_ACME_EMAIL=admin@signara.innotel.us
```

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"provider":"ACME","commonName":"signer@example.com","email":"signer@example.com"}' \
  /api/v1/certificates/provision
```

### 8.3 Cerulean (provider-held keys)

Point the provider at your Cerulean instance, then provision certificates or
import them; at signing time the caller passes `signatureValue` produced by the
Cerulean API, which Signara verifies against the stored certificate before
recording the signature.

### 8.4 Operations

- **List & inspect**: `GET /api/v1/certificates` (filter by `status`).
- **Verify**: `POST /api/v1/certificates/verify` — validity window, signature
  check against the public key, and an assurance snapshot.
- **Revoke**: `POST /api/v1/certificates/{id}/revoke` (revocation is recorded
  locally; CRL/OCSP publishing is an extension point).
- **Provider status**: `GET /api/v1/certificates/providers` shows which
  providers are configured for this deployment.
- **Renewal**: re-provision keeps the same serial → row is reactivated.
- **Audit**: certificate events flow through the standard audit trail.

Add certificate management permission (`certificates.read` /
`certificates.manage`) to roles from the admin UI or seed.

## 9. Platform admin quick reference (API)

```bash
TOKEN=<platform_admin_access_token>   # member of signara-admins group

# inventory
curl -H "Authorization: Bearer $TOKEN" /api/v1/admin/organizations
curl -H "Authorization: Bearer $TOKEN" /api/v1/admin/users
curl -H "Authorization: Bearer $TOKEN" /api/v1/admin/metrics

# lifecycle
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"SUSPENDED"}' /api/v1/admin/organizations/<org-id>/status
curl -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"status":"DEACTIVATED"}' /api/v1/admin/users/<user-id>/status
```

## 10. Day-2 checklist

- [ ] Rotate all demo/default passwords before going live
- [ ] Configure backups + test a restore (DisasterRecovery.md)
- [ ] Wire alert routing to a real inbox/channel
- [ ] Enable bucket versioning + SSE on MinIO
- [ ] Enforce MFA in Authentik for all flows
- [ ] Review audit-log retention and export cadence
