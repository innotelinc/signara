# Signara — Secure Every Signature.

Signara is a modern, open-source digital document signing and agreement management platform
built to replace proprietary e-signature platforms (DocuSign, Adobe Sign, OpenSign) while
giving you **complete ownership, privacy, security, compliance, extensibility, and
enterprise-grade infrastructure**.

Self-hosted by default. Multi-tenant by design. Authentik-native identity. Runs on the
battle-tested open-source stack of Next.js, NestJS, PostgreSQL, Redis, MinIO, and Meilisearch.

> **Repository:** [github.com/innotelinc/signara](https://github.com/innotelinc/signara)
> **Landing page:** [innotelinc.github.io/signara](https://innotelinc.github.io/signara/)
> **License:** AGPL-3.0-or-later

---

## Why Signara

| Problem                                      | Signara answer                                                        |
| -------------------------------------------- | --------------------------------------------------------------------- |
| Proprietary lock-in and per-envelope pricing | Open source, self-hosted, unlimited envelopes                         |
| Documents stored on someone else's servers   | Your MinIO/S3 storage, your encryption keys                           |
| Opaque audit trails                          | Full signing history, IP/timestamp evidence reports                   |
| Identity you don't control                   | Authentik as the native IdP — OIDC, OAuth2, SAML, SCIM, MFA, RBAC     |
| Single-tenant SaaS limitations               | Organizations → Workspaces → Teams with delegated admin               |
| No automation                                | Templates, sequential/parallel routing, approval workflows, API-first |

## Feature overview

- **Document management** — PDF/DOCX/image uploads, version history, secure storage, metadata.
- **Signature workflows** — single, multi, sequential, and parallel signers; approval routing;
  conditional workflows.
- **Templates** — reusable fields, variable replacement, dynamic data injection.
- **Identity verification** — email verification, MFA, Authentik identity validation,
  certificate-based signing, optional KYC integrations.
- **Audit trails** — complete signing history, IP tracking, timestamp validation, signature
  evidence reports.
- **Notifications** — email/SMS, reminder schedules, escalation workflows.
- **Collaboration** — teams, organizations, workspaces, shared templates and documents.
- **AI assistant** — contract summarization, risk detection, missing-field detection, template
  generation, plain-language explanations.
- **Certificate integration** — Cerulean, ACME, enterprise PKI, internal CAs.

## Technology stack

| Layer         | Technology                                                      |
| ------------- | --------------------------------------------------------------- |
| Frontend      | Next.js 14, TypeScript, TailwindCSS, shadcn/ui-style components |
| Backend       | NestJS 10, TypeScript                                           |
| Data          | PostgreSQL (Prisma ORM), Redis                                  |
| Storage       | MinIO / S3-compatible                                           |
| Search        | Meilisearch                                                     |
| Jobs          | BullMQ (Redis queues)                                           |
| Identity      | Authentik (OIDC / OAuth2 / SAML / SCIM / MFA)                   |
| Observability | Prometheus, Grafana, Loki, Alertmanager                         |
| Deployment    | Docker Compose (dev + prod), NGINX Proxy Manager                |

## Repository layout

```
signara/
├── apps/
│   ├── web/                    # Next.js frontend (apps/web)
│   └── api/                    # NestJS backend (apps/api)
├── packages/
│   ├── shared/                 # Shared DTOs, enums, constants
│   └── database/               # Prisma schema, migrations, seed
├── openapi/                    # Complete OpenAPI 3.0.3 specification
├── infra/
│   ├── cerulean/               # Cerulean DNS/NPM/TLS reconciliation
│   ├── monitoring/             # Prometheus, Grafana, Loki, Alertmanager
│   ├── nginx/                  # Legacy direct NGINX Proxy Manager automation
│   └── backup/                 # Backup & restore scripts
├── docs/                       # Architecture, Security, Deployment, API, guides...
├── .github/workflows/          # CI, security, image publishing, manual smoke checks
├── docker-compose.dev.yml      # Full local stack
├── docker-compose.prod.yml     # Production stack
└── setup.sh                    # One-shot provisioner
```

## Quick start (Docker)

```bash
cp .env.example .env              # then edit values (or let setup.sh generate secrets)
./setup.sh                        # validates prerequisites, starts stack, migrates DB
```

Or step by step:

```bash
npm install
docker compose -f docker-compose.dev.yml up -d --build
npm run db:migrate
npm run db:seed
```

Then open http://localhost:3000 (web), http://localhost:8000/api/v1 (API + Swagger).

## Quick start (production — Docker Compose)

```bash
./setup.sh --production           # generates .env + migrates production stack
```

For automatic DNS, NGINX Proxy Manager hosts, and Cerulean-managed wildcard TLS,
set `CERULEAN_DNS_API_URL`, `CERULEAN_ADMIN_PASSWORD`, `CERULEAN_BASE_DOMAIN`,
`CERULEAN_ZONE`, and the host's LAN address in `.env`, then run:

```bash
./setup.sh --production --with-cerulean
```

Cerulean permanently uses the public WAN IPv4 address for Signara DNS A records
and the host LAN IPv4 address only for NPM upstreams; Docker addresses are rejected.
The current WAN IP is checked on every normal provisioning run and persisted in
`.env` for auditability. Prior A/CNAME records for the four Signara hosts are
removed before the single WAN A record is created. See
[docs/Deployment.md](docs/Deployment.md) for Compose deployment, Cerulean, ingress,
TLS, backups, and operations.

## Documentation

| Document                                                   | Purpose                                    |
| ---------------------------------------------------------- | ------------------------------------------ |
| [docs/Architecture.md](docs/Architecture.md)               | System design, components, data flows      |
| [docs/Security.md](docs/Security.md)                       | Security baseline, threat model, hardening |
| [docs/Deployment.md](docs/Deployment.md)                   | Compose, Authentik, NGINX, backups         |
| [docs/DeveloperGuide.md](docs/DeveloperGuide.md)           | Local dev, conventions, testing            |
| [docs/API.md](docs/API.md)                                 | API overview + OpenAPI usage               |
| [docs/UserGuide.md](docs/UserGuide.md)                     | End-user workflows                         |
| [docs/AdministrationGuide.md](docs/AdministrationGuide.md) | Tenant/billing/monitoring admin            |
| [docs/DisasterRecovery.md](docs/DisasterRecovery.md)       | RPO/RTO, restore drills, runbooks          |

The interactive API reference is served by the API itself
(dev: http://localhost:8000/api/v1/docs); the full OpenAPI 3.0.3 spec lives in
[openapi/openapi.yaml](openapi/openapi.yaml).

## Development

```bash
npm install
make db:generate && make db:migrate && make db:seed
make dev     # API on :8000, web on :3000, with the rest of the stack via `make up`
```

See [docs/DeveloperGuide.md](docs/DeveloperGuide.md).

## Hosted landing page

The static project landing page is published through GitHub Pages at
[https://innotelinc.github.io/signara/](https://innotelinc.github.io/signara/). It is
maintained in [docs/landing/index.html](docs/landing/index.html) and deployed by
[.github/workflows/pages.yml](.github/workflows/pages.yml). The production Signara
application remains deployed separately with the operator-run Docker Compose flow.

## Automation and deployment

GitHub Actions run lint, tests, CodeQL and dependency scanning, validate Compose, and
publish container images with SBOMs. They do not connect to or deploy any server.

Deploy on the target host with the regular operator workflow:

```bash
git clone https://github.com/innotelinc/signara.git signara
cd signara
./setup.sh --production
```

Use `./setup.sh --production --with-cerulean` when Cerulean should provision DNS,
NGINX Proxy Manager hosts, and TLS. The optional manual smoke workflow can verify a
deployed API URL after setup; it does not perform deployment.

## Community & contribution

- Report issues: https://github.com/innotelinc/signara/issues
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) (see also [docs/DeveloperGuide.md](docs/DeveloperGuide.md))
- Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

## Security

Found a vulnerability? Do **not** open a public issue. See [docs/Security.md](docs/Security.md)
for the responsible-disclosure policy.

---

Signara — Secure Every Signature. © 2026
