# Signara — Security Baseline

> Security is a process, not a feature. This document is the operating
> baseline; deviations must be approved and tracked.

## 1. Threat model (summary)

| Asset | Primary threats | Controls |
| --- | --- | --- |
| Signed documents | Theft, tampering, unauthorized download | Envelope encryption at rest, tenant-scoped access, presigned short-lived URLs, SHA-256 checksums, version immutability |
| Signer identity | Impersonation, replay | Authentik MFA, unguessable per-signer tokens, IP/UA capture, optional cert-backed signatures |
| Audit trail | Forgery, deletion | Append-only writes (API contract + DB RLS-ready), hashes, export retention |
| Tenant data | Cross-tenant leakage | organizationId scoping at DB + API + search layers; network policies |
| Credentials | Exfiltration | httpOnly/Secure cookies, hashed refresh tokens, hashed API keys, secrets vaulting |

## 2. Authentication & sessions

- **Identity provider:** Authentik (OIDC authorization-code). Tokens validated
  against the JWKS endpoint; issuer and audience verified.
- **Session cookies:** `signara_access` (15 min) / `signara_refresh` (30 d),
  both `HttpOnly`, `Secure` (production), `SameSite=Lax/Strict`.
- **Refresh rotation:** every refresh revokes the previous session; reuse of a
  revoked token is treated as token theft (revoke user sessions).
- **MFA:** enforced at the IdP (Authentik MFA flows); `mfaEnabled` recorded per
  user for reporting.
- **Session revocation:** suspend → revoke all sessions (admin API).
- **Signing sessions:** public but credential-based — tokens are 192-bit
  random (`sgn_...`), never logged, expire with the request, and one view/sign
  per token per signer.

## 3. Authorization & RBAC

- Roles (system): `USER`, `MANAGER`, `AUDITOR`, `ADMINISTRATOR`,
  `ORGANIZATION_OWNER`; platform: `PLATFORM_ADMIN`.
- Fine-grained permissions granted via the system `Role → Permission` graph
  (seeded in `packages/database/prisma/seed.ts`).
- Enforcement points: `JwtAuthGuard` (authn), `TenantGuard` (isolation),
  `PermissionsGuard` (authz) — global guards registered in `app.module.ts`.
- Auditors get read-only visibility (`audit.read`, `audit.export`); only
  OWNER/ADMIN manage members; only PLATFORM_ADMIN can administer tenants.

## 4. Data protection

- **At rest:** documents stored in MinIO under per-tenant prefixes; enable
  SSE-S3 or MinIO KMS-backed encryption, plus bucket versioning. Sensitive
  columns (signing hashes, certificates) protected by `CRYPTO_MASTER_KEY`
  (AES-256-GCM envelope encryption for private key material — see
  `apps/api/src/common/crypto.ts`).
- **PKI custody:** certificate private keys are encrypted at rest and only
  decrypted in-memory at signing time; provider-held keys (Cerulean) never
  enter the platform. Imported keys are proven to match the certificate
  (sign/verify round-trip) before storage. Revocation and expiry are enforced
  at signing time; CRL/OCSP publishing is an extension point.
- **Checksums:** every upload computes SHA-256 stored on `Document` and each
  `DocumentVersion`; signing binds content via SHA-256 over
  `document || signer || request`.
- **In transit:** TLS 1.2+ only, HSTS preload; internal service traffic inside
  the private network (K8s NetworkPolicies default-deny).
- **Retention:** configurable; see DisasterRecovery for backup encryption.

## 5. Application hardening

| Control | Implementation |
| --- | --- |
| CSP | `default-src 'self'` + report-uri to `/api/v1/audit/csp-report` (see `main.ts`) |
| Headers | X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy, Permissions-Policy, HSTS |
| Rate limiting | Global 100 req/min/user (env-tunable); tighter limits on auth endpoints |
| Input validation | Global `ValidationPipe` (whitelist + forbid unknown) |
| Error handling | Unified envelope; no stack traces or internals leaked |
| Upload safety | Type allowlist (PDF/DOCX/PNG/JPEG/WebP), 50 MB cap, magic-byte validation recommended |
| Secrets | Never in code/git; `.env` ignored; K8s via `External Secrets`/SOPS |
| Cookies | See § 2 |
| Dependency hygiene | npm audit in CI, Dependabot, nightly Grype container scans, SBOM per release |

## 6. Secrets management

- Local/Docker: `.env` (gitignored), generated strong secrets via `setup.sh`.
- Kubernetes: apply Secret from env-file or use
  `external-secrets`/`sealed-secrets`; example manifest is
  `infra/kubernetes/base/secrets.example.yaml` (never commit real values).
- Rotation: `CRYPTO_MASTER_KEY`, JWT secrets, OIDC client secret, MinIO
  credentials, Redis password, Postgres password. Document rotation procedures
  in the runbook section of DisasterRecovery.md.

## 7. Audit logging

- Every mutating request writes an `AuditLog` row (actor, org, action,
  resource, outcome, IP, UA, duration, `requestId`) via `AuditInterceptor`.
- Signing events are append-only (`SignatureEvent`) with IP/UA/timestamps.
- Export: CSV limited to 50k rows; evidence reports include compliance
  statement (eIDAS Art. 25 / ESIGN 15 U.S.C. § 7001).
- Audit rows are never updated by the API; retention configured at DB level.

## 8. Infrastructure security

- Docker images run as **non-root** (`signara` user), `dumb-init`, read-only
  root FS (K8s), all capabilities dropped, seccomp RuntimeDefault.
- Network policies default-deny; only required ports between pods.
- NPM/ingress: force HTTPS, block common exploits, security headers on all
  five subdomains (see `infra/nginx/npm-proxy-hosts.py`).
- Monitoring endpoints (`/metrics`, `/ready`) are service-internal; the proxy
  denies external access to `/metrics`.

## 9. Compliance mapping (high level)

- **eIDAS / ESIGN** — electronic signatures + timestamped audit trail +
  evidence report. Certificate-backed signatures via
  `SignatureType.CERTIFICATE` (Cerulean/ACME/PKI integration points).
- **SOC 2 / ISO 27001-readiness** — access control, change management (CI/CD +
  release notes), monitoring, backup/DR (see DisasterRecovery.md).
- **GDPR** — data minimization, tenant isolation, deletion workflow
  (`softDelete` + purge job), audit logs for erasure requests.

## 10. Reporting vulnerabilities

**Do not open a public issue.** Email `security@signara.innotel.us` (PGP key
published on the site). Expected response: acknowledgment within 3 business
days; coordinated disclosure in 90 days. Include: version, affected
component(s), repro steps, and impact. Safe harbor: we will not pursue legal
action for good-faith research that avoids data destruction and production
impacts.