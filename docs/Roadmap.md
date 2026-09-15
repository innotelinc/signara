# Signara Roadmap

**Status:** Plan v2 — 2026-09-15
**Owner:** Innotel
**Supersedes:** the forward-looking half of `innotelinc/sign` `CONVERGENCE.md` v1
(the historical record there stays; this document owns what happens next)

---

## 1. Status at a glance

| | State | Evidence |
|---|---|---|
| **Signara (target)** | Running, healthy | `signara-{api,frontend,postgres,redis,minio,meilisearch}` up, api + frontend healthy |
| **`sign.innotel.us`** | **Serves Signara** since 2026-09-15 | NPM host retargeted to `192.168.1.46:3000`; legacy `/api/` location dropped |
| **Sign Platform (OpenSign fork)** | **Gone, not merely retired** | `192.168.1.11` answers no ICMP and nothing on `:3000`, `:8080`, `:27017`; no `sign-platform*` container or volume exists on this host |
| **Legacy data** | **Presumed lost — unverified** | The backup script lived only on `.11` (`/usr/local/bin/sign-platform-backup.sh`), was never committed to the repo, and no archive exists on this host. §6 |
| **Storage** | MinIO (bundled) | `signara-minio-1` healthy; `storage/minio.service.ts` |
| **Onyx object store** | Running, **still not usable by Signara** | `onyx-platform-onyx-objectstore-1` on `:2090`, but `services/objectstore/http.go` says *"SigV4 signing verification lands with the S3 gateway milestone"* — HTTP Basic only, so no SDK and no presigned URLs |
| **Identity** | Authentik-native, OIDC-only | `auth` module exposes `login`/`callback`/`refresh`/`logout`/`me` — **no password endpoint exists** (the posture the rest of the estate was moved to today) |
| **Sign-in test** | Passing | `scripts/verify-sso.py` — member signs in and `/auth/me` names them; an outsider is refused by the application's group binding; no password endpoint |

**One sentence:** the cutover already happened — Signara serves the public URL — so
the remaining work is not "move off OpenSign", it is "finish Signara": close the
parity gaps, get storage onto Onyx, decide what to do about the history that was
on a box that no longer exists, and put the zone's own tests and runbooks behind
it.

## 2. What "converged" means

Per the federation rule — *Cerulean owns trust, Onyx owns storage, Magnate owns
revenue, NPM Edge owns the edge* — convergence is complete when:

1. Signara is the **only** e-signature stack; no `sign-platform` repo, image,
   volume, DNS name, proxy host or document reference survives.
2. Every public name it serves is **Authentik-only** (no local credential path),
   and that claim is backed by a committed test, like the other zones.
3. Documents, signatures and audit evidence live in the **Onyx** object store,
   not in a bundled MinIO that only this host can see.
4. Its history is either **migrated** into Signara or **explicitly written off**
   with a decision recorded — never left ambiguous.
5. It has backups, a restore drill and a DR runbook that have actually been
   exercised.

## 3. Workstreams

Each workstream has an exit criterion that can be checked, not judged.

### W1 — Identity & tenancy (P1)
Authentik-native identity is in place; what is missing is the estate-level
proof and the tenant model's edges.

- [x] `scripts/verify-sso.py` in the signara repo (**done 2026-09-15**),
  modelled on the three zone tests committed the same day (cerulean / capstone /
  monarch). It drives the API's real flow — `GET /api/v1/auth/login` → Authentik
  → `GET /api/v1/auth/callback` → refresh cookie → bearer → `/api/v1/auth/me` —
  asserts the callback bound the flow with `signara_oidc_state` and issued both
  auth cookies, asserts an identity outside the bound `Signara` group is refused
  at authorization, and asserts there is no password endpoint. Exit codes 0/1/2.
  The token it needs to mint identities comes from Cerulean's `.env` (the trust
  layer) unless `AUTHENTIK_BOOTSTRAP_TOKEN` is set, overridable with
  `AUTHENTIK_ENV_FILE`.
- [ ] Confirm there is no break-glass password path in the web app (the API has
  none — check the Next.js auth routes route through the API only).
- [ ] Role model: `Organization → Workspace → Team` exists in Prisma
  (`Organization`, `Membership`, `Workspace`, `WorkspaceMember`, `Team`,
  `Role`, `Permission`); decide the **operator** view vs the **tenant** view and
  document the mapping to Authentik groups.
- [ ] Decide whether signers (external, unauthenticated parties) are ever
  Authentik users. Today they are **token-bearing guests** (`POST /signatures/public/:token/sign`,
  web route `/sign/[token]`) — that is the right model; record it so nobody
  "fixes" it later.

**Exit:** the verify script passes in CI/locally, and the guest-vs-user boundary
is written down in `docs/Security.md`.

### W2 — Feature parity with OpenSign (P1)
The old platform is gone, so parity is now about **not losing a capability a
user may still expect**, not about running two systems in parallel. The
checklist below is a starting inventory taken from the API surface on
2026-09-15; turning each row into a verified GitHub issue is the first task.

| Capability | Evidence in Signara today | Gap to close |
|---|---|---|
| Upload / versions / download | `documents` controller: `upload`, `:id`, `:id/download`, `:id/versions` | — |
| Templates + fields | `templates` module; web `/templates`, `/templates/new`, `/templates/[id]`; `TemplateField` model | verify field placement editor covers all OpenSign field types |
| Send for signature (sequential/parallel) | `signatures`: `POST /requests`, `GET /requests`, `:id/cancel`, `:id/remind`, `:id/evidence` | — |
| Guest signing without an account | `/sign/[token]`, `POST /signatures/public/:token/sign` | — |
| Reminders / escalation | `:id/remind`, `WorkflowRule` | scheduled/automatic reminders (OpenSign had a schedule) |
| Completion email | `mailer` module + `email-templates.ts`; `Notification` model | keep the sender identity so deliverability doesn't regress |
| Audit trail | `SignatureEvent` + `AuditLog`; `GET /audit/export` | — |
| Certificate of completion / evidence | `certificates` module (`provision`, `verify`, `revoke`, `:id`), `GET /signatures/requests/:id/evidence` | confirm the certificate layout matches what signers were shown before |
| API for integrators | `api-keys` module, `openapi/` | **outbound webhooks** — only mailer/signature internals reference the word today, so integrators (n8n and friends) have nothing to subscribe to |
| Bulk send | — | **no bulk endpoint**; OpenSign had one. Deliberate or not, decide |
| Branding per tenant | `Setting` model, `organizations` module | per-org logo/sender templates |
| In-person signing | — | decide: needed for the self-hosted use case, or explicitly out of scope |
| Cloud-storage imports (Drive/Dropbox/OneDrive) | — | decide; Onyx is the destination, so these are *sources* only |
| SMS / WhatsApp delivery | — | decide; email-only is defensible, but say so |
| i18n | **no locales directory found** | OpenSign shipped many languages; if the estate has non-English signers this is a real gap |
| Billing | `billing` module (`plans`, `subscriptions`, `invoices`, `usage`) | align with Magnate as the revenue owner (the estate rule) rather than a second billing system |
| Admin/ops view | `admin`: orgs, users, status, `metrics` | — |

**Exit:** every row is either **shipped**, **decided out of scope with a reason**,
or **scheduled** — nothing is "unknown".

### W3 — Storage onto Onyx (P2, the one hard blocker)
Onyx v0.1's object store authenticates with HTTP Basic only; AWS SigV4 and
presigned URLs are deferred to its S3-gateway milestone
(`4-social/onyx/services/objectstore/http.go`). Signara's storage service is a
MinIO S3 client, so it **cannot** talk to Onyx until that lands.

Two tracks, run in parallel:

- **Track A (unblock):** land SigV4 request verification + presigned URL
  generation in Onyx's objectstore. This is upstream work in the Onyx repo, not
  in Signara, and it unblocks every S3-shaped consumer in the estate, not just
  this one. It is the single highest-leverage item on this roadmap.
- **Track B (de-risk while A is open):** make the storage driver a **first-class
  configurable profile** in Signara rather than a hardcoded `http://minio:9000`.
  Today the compose hardcodes MinIO and an override file is needed to point
  elsewhere. Ship `S3_*` as documented, supported configuration (endpoint,
  public endpoint, keys, bucket, path-style, region) with a **contract test**
  that runs the upload → presign → download → delete round trip against whatever
  endpoint is configured. Then the Onyx cutover is a config change plus a data
  copy, not a code change.

**Exit:** the round-trip contract test is green against Onyx, `S3_ENDPOINT`
points at it in production, and bundled MinIO is dev-only/removed.

### W4 — Legacy history (P3, re-scoped)
See §6. The ETL described in `CONVERGENCE.md` v1 (Mongo → Postgres, files →
Onyx `legacy/sign-platform/`) is **only worth writing if the source exists**.

**Exit:** either the ETL runs and counts reconcile and a pilot tenant reads its
own history inside Signara, **or** a recorded decision says the history is
written off, with the recovery attempt and its result documented.

### W5 — Edge, delivery and certificates (P4 — mostly done)
- [x] `sign.innotel.us` serves Signara; `CORS_ORIGINS` includes it.
- [ ] Trim or confirm the alias set (`app.`, `api.`, `auth.`, `storage.signara.innotel.us`) — every
  extra public name is another door to keep gated and certified.
- [ ] Certificates: confirm the zone's wildcard covers every name above and that
  the ACME DNS-01 path still runs through Cerulean/Technitium.
- [ ] Mail: keep `MAILGUN_SENDER`/SMTP identity stable and verify SPF/DKIM/DMARC
  for the signing domain *before* anything else changes — completion emails are
  the product's most visible surface.
- [ ] Re-point anything still describing "sign-platform" in docs/comments.

**Exit:** one documented public name set, valid certs, mail authenticated, no
stale references.

### W6 — Operations (P5)
- [ ] **Backups that exist off the box:** database dump + object store, to a
  location that is not the host being backed up (this is exactly the failure
  that lost the legacy data).
- [ ] A **restore drill** that has been performed and recorded in
  `docs/DisasterRecovery.md`.
- [ ] Monitoring on the api/web/queue (the estate already runs SigNoz).
- [ ] An upgrade path (Prisma migrations + image pinning) written down.

**Exit:** the restore drill is a dated entry in the DR doc, not a plan.

## 4. Phase plan

| Phase | Scope | Status | Exit criteria |
|---|---|---|---|
| **P0 — Freeze legacy** | sign-platform stable fallback + backups | **Moot** — the host is gone; nothing to freeze | replaced by §6 recovery attempt |
| **P1 — Parity** | W1 + W2 | **In progress** | every parity row shipped/decided/scheduled; verify script green |
| **P2 — Onyx** | W3 | **Blocked on Onyx SigV4** | round-trip contract test green against Onyx in prod |
| **P3 — Migration** | W4 | **Conditional on §6** | counts reconcile *or* a recorded write-off |
| **P4 — Cutover** | W5 | **Done** (2026-09-15) | signers sign on Signara at `sign.innotel.us` |
| **P5 — Retire legacy** | archive the `sign` repo, drop dead DNS/proxy hosts, final doc pass | **Not started** | nothing in the estate refers to OpenSign except history |

## 5. Next actions (ordered)

1. **Timebox the legacy-data recovery (§6)** — a day of looking, not a project.
   Everything in P3 depends on the answer.
2. ~~Write `signara/scripts/verify-sso.py`~~ — **done 2026-09-15**; it passes
   against the live deployment, which closes the last untested zone.
3. **File the W2 parity checklist as issues**, one per row, each with an
   explicit ship/out-of-scope decision.
4. **Open the Onyx SigV4 work item** and land it; until then treat Track B
   (configurable storage profile + contract test) as the deliverable.
5. **Make the backup target a different host** and run one restore drill.

## 6. The legacy data question (do this first)

What is known:

- `192.168.1.11` answers nothing on ICMP, `:3000`, `:8080` or `:27017`.
- No `sign-platform*` container or volume exists on this host, and nothing named
  `sign-platform` is on this filesystem.
- `/var/backups` here holds only OS-level artefacts (alternatives, apt state).
- The nightly backup script was `/usr/local/bin/sign-platform-backup.sh` **on
  `.11`** and was never committed, so its destination is unrecorded — and if it
  wrote to `.11`'s own disk, the archives died with the box.

Decision tree:

| Finding | Then |
|---|---|
| `.11` boots, or its disk can be attached | P3 as originally planned: dump + `opensign-files` volume → ETL → Onyx `legacy/` prefix |
| An archive exists elsewhere (another host, cloud bucket, an operator's laptop) | P3 with the ETL written against the archive; verification report against `DocumentHash` |
| Neither | **Record the write-off.** Signara starts clean; offer a documented import path (an operator can still hand over a PDF) and make sure nobody promises "your old envelopes are in here" |

The recovery attempt, whatever it finds, gets written into this document rather
than living in someone's memory — the reason this is a risk at all is that the
last migration's durability depended on an unversioned script on a single box.

## 7. Risks

- **A second silent data loss.** Signara's own backups have not been proven
  restorable and are not obviously off-host (§W6). Fix before anything else
  changes.
- **Onyx's SigV4 milestone slips.** Track B keeps Signara shippable meanwhile;
  do not let the storage question block W1/W2.
- **Parity by assumption.** The checklist above is an inventory of API surface,
  not of user expectations. Rows marked "decide" need a decision from the owner,
  not a default.
- **Two billing systems.** Signara has a `billing` module; the estate's rule is
  Magnate owns revenue. Resolve deliberately or it will drift into a second
  source of truth.
- **Public-name sprawl.** Every alias is another gated, certified, monitored
  surface; the estate just spent a day closing exactly those.

## 8. Decisions needed

1. **Legacy data:** timebox the recovery, or write it off now? (§6)
2. **Parity rows marked "decide"** — bulk send, in-person signing, cloud-storage
   imports, SMS/WhatsApp, i18n: ship or explicitly out of scope?
3. **Billing:** Signara's module as a Magnate client, or removed?

---

*Companion docs: `docs/Architecture.md`, `docs/Deployment.md`,
`docs/Security.md`, `docs/DisasterRecovery.md`;
`1-primary/sign/CONVERGENCE.md` (v1 history and the data mapping tables);
`ips/docs/sign-in-posture.md` (the estate sign-in posture these workstreams plug
into).*
