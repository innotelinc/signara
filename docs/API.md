# Signara — API Reference

This document summarizes the REST API. **The authoritative, interactive spec is
served by the running API**:

| Environment | URL |
| --- | --- |
| Swagger UI | `https://api.signara.innotel.us/api/v1/docs` |
| OpenAPI YAML | `https://api.signara.innotel.us/api/v1/openapi.yaml` |
| Source of truth | [`openapi/openapi.yaml`](../openapi/openapi.yaml) |

Base path: `/api/v1`

## Authentication

Two schemes (OpenAPI security schemes `access-token` and `api-key`):

```bash
# Interactive sessions (JWT issued by the OIDC flow)
curl -H "Authorization: Bearer <access_token>" https://api.signara.innotel.us/api/v1/auth/me

# Machine clients (key created via POST /api-keys)
curl -H "X-API-Key: sgn_..." https://api.signara.innotel.us/api/v1/documents
```

Interactive login is browser-based:

```
GET /api/v1/auth/login?next=/dashboard   → 302 to Authentik
GET /api/v1/auth/callback?code=&state=   → session cookies set
```

## Tenancy & idempotency

- Tenant-scoped endpoints return `403` without an active organization.
- Mutating endpoints accept `X-Idempotency-Key`; repeat requests with the same
  key return the previously stored response.

## Endpoint map

| Area | Base path | Highlights |
| --- | --- | --- |
| Auth | `/auth` | login, callback, refresh, logout, me |
| Organizations | `/organizations` | current profile, workspaces, teams |
| Users | `/users` | me, members, invite, role changes, remove |
| Documents | `/documents` | upload, list/search, versions, download, delete |
| Templates | `/templates` | CRUD + fields + variables |
| Signatures | `/signatures` | requests CRUD, cancel, remind, evidence, public token signing |
| Audit | `/audit` | query, CSV export, CSP-report ingestion |
| Billing | `/billing` | account, plans, subscriptions, invoices, usage |
| Notifications | `/notifications` | list, mark read |
| API keys | `/api-keys` | create (key shown once), list, revoke |
| Admin | `/admin` | cross-tenant org/user management, metrics |
| System | `/health`, `/ready`, `/metrics` | liveness, readiness, Prometheus |

## Examples

### Create a signing request

```bash
curl -X POST https://api.signara.innotel.us/api/v1/signatures/requests \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "documentId": "<uuid>",
    "mode": "SEQUENTIAL",
    "deadline": "2026-12-31T23:59:59Z",
    "message": "Please review and sign.",
    "signers": [
      { "email": "ceo@acme.example", "name": "Ada CEO", "orderIndex": 0 },
      { "email": "cfo@acme.example", "name": "Bob CFO", "orderIndex": 1 }
    ]
  }'
```

### Sign as a recipient (public token endpoints)

```bash
curl https://api.signara.innotel.us/api/v1/signatures/public/sgn_<token>
curl -X POST https://api.signara.innotel.us/api/v1/signatures/public/sgn_<token>/sign \
  -H "Content-Type: application/json" -d '{"type":"TYPED"}'
curl https://api.signara.innotel.us/api/v1/signatures/public/sgn_<token>/events
```

### Upload a document

```bash
curl -X POST https://api.signara.innotel.us/api/v1/documents/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@contract.pdf" -F "tags=legal" -F "title=Q3 Contract"
```

### Generate the evidence report

```bash
curl https://api.signara.innotel.us/api/v1/signatures/requests/<uuid>/evidence \
  -H "Authorization: Bearer $TOKEN"
```

### Export the audit log

```bash
curl -o audit.csv https://api.signara.innotel.us/api/v1/audit/export?from=2026-01-01 \
  -H "Authorization: Bearer $TOKEN"
```

## Pagination

List endpoints accept `limit` (default 25, max varies 100–500) and `offset`;
responses return `{ total, items }` (with `limit`/`offset` echoed where
relevant).

## Errors

```json
{
  "statusCode": 403,
  "error": "Forbidden",
  "message": ["Missing required permission: documents.read"],
  "path": "/api/v1/documents",
  "timestamp": "2026-09-01T12:00:00.000Z",
  "requestId": "req_abc123"
}
```

| Code | Meaning |
| --- | --- |
| 400 | Validation / business rule violation |
| 401 | Missing or invalid credentials |
| 403 | Authenticated but not permitted (or no tenant) |
| 404 | Not found (also used for foreign-tenant resources) |
| 409 | State conflict (duplicate, already signed, etc.) |
| 429 | Rate limit exceeded |

## Versioning & compatibility

- Path versioning: `/api/v1`. Breaking changes introduce `/api/v2`.
- The OpenAPI spec is versioned in lockstep with releases; regenerated from
  Swagger and manually curated in `openapi/openapi.yaml`.