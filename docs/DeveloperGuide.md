# Signara — Developer Guide

## 1. Prerequisites

- Node.js ≥ 20 (npm ≥ 10), Docker + compose v2
- Recommended: `pnpm` not required — the repo uses npm workspaces

## 2. First run

```bash
# 1. Install workspace dependencies
npm install

# 2. Start the infrastructure (Postgres, Redis, MinIO, Meilisearch, Authentik,
#    Prometheus, Grafana, Loki, Alertmanager)
docker compose -f docker-compose.dev.yml up -d postgres redis minio meilisearch authentik-server authentik-worker authentik-db authentik-redis

# 3. Copy env and keep the dev values
cp .env.example .env

# 4. Database setup
npm run db:generate     # generate Prisma client
npm run db:migrate      # apply migrations (prisma migrate deploy)
npm run db:seed         # roles, permissions, plans, demo tenant

# 5. Run the apps in watch mode
make dev                # API on :8000, web on :3000
```

Swagger: http://localhost:8000/api/v1/docs

## 3. Workspace layout

| Package             | What's inside                                               |
| ------------------- | ----------------------------------------------------------- |
| `apps/api`          | NestJS REST API — modules under `src/modules/*`             |
| `apps/web`          | Next.js app router — pages under `src/app/*`                |
| `packages/database` | Prisma schema, `prisma/migrations/*`, `prisma/seed.ts`      |
| `packages/shared`   | Shared constants and contracts                              |
| `openapi/`          | OpenAPI spec — regenerate from Swagger as you add endpoints |
| `infra/`            | Compose support, monitoring, NGINX automation, backup       |

## 4. Conventions

- **NestJS**: module = controller + service + (dto + guards) colocated in
  `src/modules/<name>/`. Services own all Prisma access; controllers stay thin.
- **RBAC**: decorate routes with `@Permissions('documents.read')`; add new
  codes to `Permission` + seed, then to a role in `seed.ts`.
- **Tenancy**: always scope Prisma queries by `organizationId` from
  `user.org.id` (`@CurrentUser()`). Never trust client-supplied org ids.
- **Naming**: files `kebab-case`; classes `PascalCase`; constants `UPPER_SNAKE`.
- **Formatting**: Prettier (repo config). `npm run format`.
- **Commits**: Conventional Commits — `feat:`, `fix:`, `docs:`, `chore:`.
- **DB changes**:
  ```bash
  npm run db:dev -w @signara/database   # prisma migrate dev — creates migration
  ```
  Always review the generated SQL in `prisma/migrations/<ts>_<name>/migration.sql`
  before committing.

## 5. Testing

| Layer          | Command                         | Notes                                            |
| -------------- | ------------------------------- | ------------------------------------------------ |
| Unit           | `npm run test -w @signara/api`  | Jest + ts-jest; see `signatures.service.spec.ts` |
| Typecheck      | `npm run typecheck`             | strict TS across workspaces                      |
| Lint           | `npm run lint`                  | `tsc --noEmit` (API) + `next lint` (web)         |
| Compose syntax | `docker compose config --quiet` | CI validates both compose files                  |
| E2E smoke      | `make up && curl /ready`        | CI boots the API against a disposable Postgres   |

## 6. Environment

Copy `.env.example` → `.env`. Key dev defaults:

```
DATABASE_URL=postgresql://signara:signara@localhost:5432/signara?schema=public
REDIS_URL=redis://:signara@localhost:6379
S3_ENDPOINT=http://localhost:9000
OIDC_JWKS_URL=https://auth.signara.innotel.us/application/o/signara/jwks/
OIDC_ISSUER_URL=https://auth.signara.innotel.us/application/o/signara/
```

If Authentik isn't configured yet, the API still boots; authenticated routes
require a valid IdP token (test with a temporary `signara_access` cookie or
`Authorization: Bearer` issued via `/auth/login` once the provider is up).

## 7. Common workflows

### Add an API endpoint

1. Add DTO + route in the module's controller.
2. Implement logic in the service, scoped by tenant.
3. Add `@Permissions(...)` and regenerate Swagger (automatic).
4. Document new/changed paths in `openapi/openapi.yaml`.

### Add a database model

1. Edit `packages/database/prisma/schema.prisma`.
2. `npm run db:dev -w @signara/database` → review SQL.
3. `npm run db:generate`.
4. Update `docs/er-diagram.md` if entities/relations changed.

### Run a background job locally

```bash
# API boots the workers automatically (JobsModule). Watch the queue:
docker compose -f docker-compose.dev.yml exec redis redis-cli -a signara
> keys '*'                     # job keys
```

## 8. Troubleshooting

| Symptom                            | Fix                                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `P1001: Can't reach database`      | is Postgres running? `pg_isready`; check `.env` DATABASE_URL                                    |
| `PrismaClientInitializationError`  | `npm run db:generate`                                                                           |
| Upload 400 "Unsupported file type" | the client set a generic `application/octet-stream`; set `Content-Type` from the file extension |
| 403 "No active tenant"             | user has no ACTIVE/TRIAL membership — seed the demo org or invite yourself                      |
| 401 on /auth/me                    | missing/invalid IdP token — run the OIDC flow or refresh                                        |

See [AdministrationGuide.md](AdministrationGuide.md) for tenant/admin topics and
[Security.md](Security.md) for hardening a dev instance (dev defaults are weak
by design).
