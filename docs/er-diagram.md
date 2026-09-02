# Signara — Entity-Relationship Diagram

Source of truth: `packages/database/prisma/schema.prisma`
Migrations: `packages/database/prisma/migrations/`

All primary keys are `uuid()` strings. Every tenant-owned table carries `organizationId`
(except global/system tables) and is queried through the tenant isolation layer — see
[Architecture.md](Architecture.md#tenant-isolation) and
[AdministrationGuide.md](AdministrationGuide.md#tenant-isolation).

```mermaid
erDiagram
    User ||--o{ Membership : "member of"
    User ||--o{ WorkspaceMember : "member of"
    User ||--o{ TeamMember : "member of"
    User ||--o{ Document : "created"
    User ||--o{ Template : "created"
    User ||--o{ SigningRequest : "created"
    User ||--o{ Signer : "signs as"
    User ||--o{ ApiKey : "owns"
    User ||--o{ Notification : "receives"
    User ||--o{ Session : "has"
    User ||--o{ AuditLog : "actor"

    Organization ||--o{ Membership : "has members"
    Organization ||--o{ Workspace : "has"
    Organization ||--o{ Team : "has"
    Organization ||--o{ Document : "owns"
    Organization ||--o{ Template : "owns"
    Organization ||--o{ BillingAccount : "has one"
    Organization ||--o{ ApiKey : "issues"
    Organization ||--o{ Setting : "config"
    Organization ||--o{ AuditLog : "scoped to"

    Role ||--o{ Membership : "assigned"
    Role ||--o{ RolePermission : "grants"
    Permission ||--o{ RolePermission : "included in"

    Workspace ||--o{ WorkspaceMember : "has members"
    Workspace ||--o{ Team : "groups"
    Workspace ||--o{ Document : "contains"
    Workspace ||--o{ Template : "contains"

    Team ||--o{ TeamMember : "has members"

    Document ||--o{ DocumentVersion : "versioned by"
    Document ||--o{ SigningRequest : "requested"
    Document ||--o{ Signature : "carries"
    Template ||--o{ TemplateField : "defines fields on"
    Template o|--o{ Document : "instantiates"

    SigningRequest ||--o{ Signer : "lists"
    SigningRequest ||--o{ SignatureEvent : "records"
    SigningRequest ||--o{ Signature : "collects"
    SigningRequest ||--o{ WorkflowRule : "routes by"
    Signer ||--o{ Signature : "produces"
    Signer ||--o{ SignatureEvent : "triggers"

    BillingAccount ||--o{ Subscription : "has"
    BillingAccount ||--o{ Invoice : "receives"
    BillingAccount ||--o{ CouponRedemption : "redeems"
    Coupon ||--o{ CouponRedemption : "used in"
    Plan ||--o{ Subscription : "priced by"
    Subscription ||--o{ Invoice : "billed by"

    Setting }o--o| Organization : "org-scoped"
    IdempotencyKey }o--o| Organization : "org-scoped"
```

## Key relationships

| Pair | Cardinality | Notes |
| --- | --- | --- |
| Organization → Workspace → Team | 1:N / 1:N | Team may be org-level (`workspaceId` null) |
| Membership | unique (org, user) | Role enum + optional custom `Role` FK |
| Document ↔ DocumentVersion | 1:N | immutable versions, unique (document, version) |
| Document ↔ SigningRequest → Signer | 1:N / 1:N | sequential order via `Signer.orderIndex` |
| Signer ↔ Signature | 1:0..N | one signature per signer per request in practice |
| SignatureEvent | append-only | every signing lifecycle transition |
| BillingAccount | unique (organization) | 1:1 with Organization |
| AuditLog | append-only | org-scoped; never updated, only inserted |

## Integrity rules (enforced in migration SQL)

- `Document.sizeBytes >= 0`, `Document.version >= 1`
- `Signer.orderIndex >= 0`, `reminderCount >= 0`
- `Plan.price* >= 0`, `Subscription.seats >= 1`, `Invoice.amountDue >= 0`
- Partial unique index: at most one global `Setting` row per `key`
- Functional index for case-insensitive pending-signer lookup
- `AuditLog`/`SignatureEvent` are append-only by contract (guards at the API layer)

See [docs/Deployment.md](Deployment.md) for backup/restore of this schema.