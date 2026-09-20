# Signara Roadmap

**Status:** Plan v2 — 2026-09-15
**Owner:** Innotel
**Supersedes:** the forward-looking half of `innotelinc/sign` `CONVERGENCE.md` v1
(the historical record there stays; this document owns what happens next)

---

## 1. Status at a glance

|                                   | State                                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signara (target)**              | Running, healthy                                           | `signara-{api,frontend,postgres,redis,minio,meilisearch}` up, api + frontend healthy                                                                                                                                                                                                                                                                                                    |
| **`sign.innotel.us`**             | **Serves Signara** since 2026-09-15                        | NPM host retargeted to `192.168.1.46:3000`; legacy `/api/` location dropped                                                                                                                                                                                                                                                                                                             |
| **Sign Platform (OpenSign fork)** | **Gone, not merely retired**                               | `192.168.1.11` answers no ICMP and nothing on `:3000`, `:8080`, `:27017`; no `sign-platform*` container or volume exists on this host                                                                                                                                                                                                                                                   |
| **Legacy data**                   | **Presumed lost — unverified**                             | The backup script lived only on `.11` (`/usr/local/bin/sign-platform-backup.sh`), was never committed to the repo, and no archive exists on this host. §6                                                                                                                                                                                                                               |
| **Storage**                       | **onyx-objectstore; MinIO demoted to rollback**            | API reads the `SIGNARA_S3_*` profile; 12 objects migrated and hash-verified; `signara-minio-1` stopped, `--profile legacy-storage` brings it back                                                                                                                                                                                                                                       |
| **Onyx object store**             | **SigV4, deployed, and pinned to AWS's published vectors** | `services/objectstore/sigv4.go` verifies `AWS4-HMAC-SHA256` header auth _and_ presigned URLs; `sigv4_test.go` pins the key derivation to the published AWS vector. `storage.contract.spec.ts` runs put → stat → presign → fetch → delete through minio-js against a standalone build: **6/6** (2026-09-15). HTTP Basic is still accepted so an existing deployment survives the upgrade |
| **Identity**                      | Authentik-native, OIDC-only                                | `auth` module exposes `login`/`callback`/`refresh`/`logout`/`me` — **no password endpoint exists** (the posture the rest of the estate was moved to today)                                                                                                                                                                                                                              |
| **Sign-in test**                  | Passing                                                    | `scripts/verify-sso.py` — member signs in and `/auth/me` names them; an outsider is refused by the application's group binding; no password endpoint                                                                                                                                                                                                                                    |

**One sentence:** the cutover already happened — Signara serves the public URL — so
the remaining work is not "move off OpenSign", it is "finish Signara": close the
parity gaps, get storage onto Onyx, decide what to do about the history that was
on a box that no longer exists, and put the zone's own tests and runbooks behind
it.

## 2. What "converged" means

Per the federation rule — _Cerulean owns trust, Onyx owns storage, Magnate owns
revenue, NPM Edge owns the edge_ — convergence is complete when:

1. Signara is the **only** e-signature stack; no `sign-platform` repo, image,
   volume, DNS name, proxy host or document reference survives. (The `sign`
   repository itself survives as an archived, read-only historical record —
   that is the recorded past, not a deployable second stack.)
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
- [x] **No break-glass password path — confirmed 2026-09-20, both sides.** The API
      exposes only `login`/`callback`/`refresh`/`logout`/`me` and the auth module
      mentions passwords nowhere. The web app is the part that was unverified: it
      depends on `next`/`react`/`react-dom`/`lucide-react` only — no auth library —
      and has **no `app/api` route handlers**, so there is no route that could
      accept a credential; `/login` is an interstitial that sends the browser to
      the API's OIDC login. Now recorded in `docs/Security.md` and asserted on the
      running deployment by the smoke test, not just read once.
- [x] **Role model documented 2026-09-20** (`docs/Security.md` §3): entry is the
      Authentik application's group binding; `IDP_ADMIN_GROUP` (default
      `signara-admins`) in the OIDC `groups` claim maps to `User.platformRole` and
      gives the **operator** view (`admin` module, `PermissionsGuard`
      short-circuit, least-privilege `USER` otherwise); the **tenant** view is the
      Prisma `Role`/`Permission` graph via `Membership`/`WorkspaceMember`, scoped by
      `TenantGuard`. Written down explicitly because the asymmetry is the
      surprising part: Authentik never assigns tenant roles, and Signara never
      creates Authentik groups.
- [x] **Signers are token-bearing guests, decided and recorded 2026-09-20.**
      `sgn_<192-bit>` on the four `@Public()` routes (`GET|POST
/signatures/public/:token{,/sign,/decline,/events}`) plus web `/sign/[token]`;
      never Authentik users, and `docs/Security.md` §2 says why that is deliberate
      so nobody "fixes" it later.

**Exit:** the verify script passes in CI/locally, and the guest-vs-user boundary
is written down in `docs/Security.md`. — **met 2026-09-20**: §2 now carries the
user/guest boundary table and the "no password door" evidence; verify-sso.py was
re-run green against the live deployment the same day. **W1 is closed.**

### W2 — Feature parity with OpenSign (P1)

The old platform is gone, so parity is now about **not losing a capability a
user may still expect**, not about running two systems in parallel. The
checklist below is a starting inventory taken from the API surface on
2026-09-15. **Filed 2026-09-15 as issues #81–#92** (one per gap and per
"decide" row; the shipped rows have none). The issues carry the product
statements — the bodies name no internal host or address, because the repository
is public — so this table stays the internal view and the tracker is the working
one.

The reference the rows are measured against is [`docs/OpenSignParity.md`](OpenSignParity.md),
harvested from the fork on 2026-09-20 before it was frozen: the field vocabulary
#81 has to cover (and the behaviours its strings imply), the request and
completion mail subjects and bodies #83 has to keep, and the certificate layout
#84 has to match. Nothing in it is a code port — only what a user saw.

| Capability                                     | Evidence in Signara today                                                                                                               | Gap to close                                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload / versions / download                   | `documents` controller: `upload`, `:id`, `:id/download`, `:id/versions`                                                                 | —                                                                                                                                               |
| Templates + fields                             | `templates` module; web `/templates`, `/templates/new`, `/templates/[id]`; `TemplateField` model                                        | verify field placement editor covers all OpenSign field types                                                                                   |
| Send for signature (sequential/parallel)       | `signatures`: `POST /requests`, `GET /requests`, `:id/cancel`, `:id/remind`, `:id/evidence`                                             | —                                                                                                                                               |
| Guest signing without an account               | `/sign/[token]`, `POST /signatures/public/:token/sign`                                                                                  | —                                                                                                                                               |
| Reminders / escalation                         | `:id/remind`, `WorkflowRule`, and a scheduled sweep (`sweepDueReminders`, repeatable `signing` queue job) — **landed 2026-09-20** (#82) | —                                                                                                                                               |
| Completion email                               | `mailer` module + `email-templates.ts`; `Notification` model                                                                            | keep the sender identity so deliverability doesn't regress                                                                                      |
| Audit trail                                    | `SignatureEvent` + `AuditLog`; `GET /audit/export`                                                                                      | —                                                                                                                                               |
| Certificate of completion / evidence           | `certificates` module (`provision`, `verify`, `revoke`, `:id`), `GET /signatures/requests/:id/evidence`                                 | confirm the certificate layout matches what signers were shown before                                                                           |
| API for integrators                            | `api-keys` module, `openapi/`                                                                                                           | **outbound webhooks** — only mailer/signature internals reference the word today, so integrators (n8n and friends) have nothing to subscribe to |
| Bulk send                                      | —                                                                                                                                       | **no bulk endpoint**; OpenSign had one. Deliberate or not, decide                                                                               |
| Branding per tenant                            | `Setting` model, `organizations` module                                                                                                 | per-org logo/sender templates                                                                                                                   |
| In-person signing                              | —                                                                                                                                       | decide: needed for the self-hosted use case, or explicitly out of scope                                                                         |
| Cloud-storage imports (Drive/Dropbox/OneDrive) | —                                                                                                                                       | decide; Onyx is the destination, so these are _sources_ only                                                                                    |
| SMS / WhatsApp delivery                        | —                                                                                                                                       | decide; email-only is defensible, but say so                                                                                                    |
| i18n                                           | `public/locales/` with 7 catalogs (de, en, es, fr, hi, it, kr) harvested from the retired fork, wired through `web/src/lib/i18n/`       | the harvested catalogs describe OpenSign's screens, not Signara's newer ones — extract the remaining strings into keys as screens are touched   |
| Billing                                        | `billing` module (`plans`, `subscriptions`, `invoices`, `usage`)                                                                        | align with Magnate as the revenue owner (the estate rule) rather than a second billing system                                                   |
| Admin/ops view                                 | `admin`: orgs, users, status, `metrics`                                                                                                 | —                                                                                                                                               |

**Exit:** every row is either **shipped**, **decided out of scope with a reason**,
or **scheduled** — nothing is "unknown". Status: 7 rows shipped (upload,
versions, download; send for signature; guest signing; audit trail; admin/ops;
reminders — #82, 2026-09-20), **11 still filed as issues #81, #83–#92** — 7 gaps
and 4 decisions (bulk send, in-person signing, cloud-storage import,
SMS/WhatsApp), plus the billing question in §8. Two tracker premises were stale
and are corrected on the issues: #91 (the locales exist — 7 catalogs shipped
2026-09-20) and #82 (the manual reminder was also sending the _invite_ template,
because the enqueued job never said it was a reminder).

### W3 — Storage onto Onyx (P2, the one hard blocker)

Onyx v0.1's object store authenticated with HTTP Basic only, which no S3 SDK
speaks — so Signara's MinIO client could not talk to it, and presigned URLs,
which is how a browser fetches a document without the API proxying every byte,
were impossible. Both tracks of this workstream are now landed:

- **Track A (unblock) — done.** `4-social/onyx/services/objectstore/sigv4.go`
  implements AWS Signature Version 4 from the specification: the
  `AWS4-HMAC-SHA256` header form every SDK produces, and the presigned-URL form
  in the query string. It verifies the canonical request, the payload hash
  (`x-amz-content-sha256`, restoring the body for the handler afterwards),
  enforces a 15-minute clock skew and the `X-Amz-Expires` window, and refuses a
  request whose declared `SignedHeaders` are not all present. HTTP Basic is
  kept, so an existing deployment survives the upgrade — but a request that
  _claims_ SigV4 never falls back to it, which `sigv4_test.go` asserts. The
  signing-key derivation is pinned to the worked example published by AWS, so a
  failure names the primitive rather than the request.
  Landed upstream in Onyx, so this unblocks every S3-shaped consumer in the
  estate, not just Signara.
- **Track B (de-risked) — done.** The driver is a supported `S3_*` profile
  (endpoint, public endpoint, keys, bucket, path-style, region), and
  `storage.contract.spec.ts` is the contract test: upload → stat (incl. the
  checksum metadata) → presign → _fetch the presigned URL_ → read back → delete,
  run through minio-js so it exercises the real client rather than a stub. It is
  `S3_CONTRACT=1`-gated, so `npm test` stays hermetic.

Two gaps Track A exposed in Onyx, both fixed in the same pass: the endpoint
answered `Method Not Allowed` for `HEAD` bucket/object (every SDK probes a bucket
before writing), and it dropped `x-amz-meta-*` headers, so a client could not
check a download against the hash it uploaded.

**Exit — met 2026-09-15.** Both the contract and the deployment half are done and
verified end to end:

- The store was rebuilt from this tree and redeployed, so SigV4 exists in the
  _running_ container. Proven with the repo's own forward probe —
  `scripts/onyx-s3-test.mjs`, written when SDK support was still a prediction and
  now passing — and with `storage.contract.spec.ts` against the deployed endpoint
  and its real credentials, 6/6, presigned fetch included.
- `scripts/migrate-object-store.mjs` copied **and verified** all 12 objects
  (259,679 bytes): each was read back out of the target and compared on size and
  SHA-256, and every hash matched the `checksumSha256` the database already held.
- The API reads the `SIGNARA_S3_*` profile (a config change, not a code change —
  §5, and “Storage profile” in `docs/Deployment.md` for the rollback), MinIO is reduced to the
  `legacy-storage` profile and stopped, and its own credentials were deliberately
  left untouched so it can be restarted for a rollback.
- Verified through the **browser** path rather than only the API: a presigned URL
  signed for `storage.signara.innotel.us`, fetched through the edge, returned
  bytes whose SHA-256 equals the recorded checksum — with MinIO stopped. The same
  URL replayed against a different host is refused (`SignatureDoesNotMatch`).

**Track A had a third gap, and only running it live found it.** The bucket listing
read a bucket's top level and skipped directories, so every key containing `/` was
invisible — and every key Signara writes is `<org>/documents/<uuid>.pdf`. The
running store listed **1** object while holding **16**. Anything built on a
listing — a backup, an inventory, an age-out sweep — would have omitted every
document _without an error_. The listing is now recursive and honours
`prefix`/`delimiter`, with `http_list_test.go` pinning it and the REST smoke test
covering it end to end.

Two stale artefacts were corrected in the same pass: `onyx-objectstore-smoke.sh`
claimed SDKs could not talk to the store, and its own object calls omitted the
bucket from the URL, so it could never have passed; and `onyx-s3-test.mjs` was
still labelled a probe that was expected to fail.

### W4 — Legacy history (P3, re-scoped)

See §6. The ETL described in `CONVERGENCE.md` v1 (Mongo → Postgres, files →
Onyx `legacy/sign-platform/`) is **only worth writing if the source exists**.

**Exit:** either the ETL runs and counts reconcile and a pilot tenant reads its
own history inside Signara, **or** a recorded decision says the history is
written off, with the recovery attempt and its result documented.

**Met 2026-09-15 — written off.** The recovery attempt is recorded below, with
the sources checked and what each returned. No ETL will be written; see §6 for
what is owed to users in place of the history.

### W5 — Edge, delivery and certificates (P4 — mostly done)

- [x] `sign.innotel.us` serves Signara; `CORS_ORIGINS` includes it.
- [ ] Trim or confirm the alias set (`app.`, `api.`, `auth.`, `storage.signara.innotel.us`) — every
      extra public name is another door to keep gated and certified.
- [ ] Certificates: confirm the zone's wildcard covers every name above and that
      the ACME DNS-01 path still runs through Cerulean/Technitium.
- [ ] Mail: keep `MAILGUN_SENDER`/SMTP identity stable and verify SPF/DKIM/DMARC
      for the signing domain _before_ anything else changes — completion emails are
      the product's most visible surface.
- [x] Re-point anything still describing "sign-platform" in docs/comments — **done
      2026-09-19**: an estate-wide audit found no live references outside the
      retirement record itself, and the `sign` repo's forward-looking claims (README,
      `docs/stack.md`, the landing page) now say retired rather than "converging".
      Findings in `1-primary/sign/ARCHIVE.md` §7.

**Exit:** one documented public name set, valid certs, mail authenticated, no
stale references.

### W6 — Operations (P5)

- [ ] **Backups that exist off the box:** the job now runs on the deployment with
      a working mirror — `BACKUP_S3_*` → ONYX's object store, `BACKUP_REQUIRE_REMOTE=true`,
      the identity database included, all four metrics healthy as of 2026-09-20
      (`status 1`, `remote_enabled 1`, `remote_last_success` fresh,
      `identity_covered 1`) — **but it is the same host, so
      `signara_backup_mirror_offhost` is 0 and `BackupIsLocalOnly` correctly keeps
      alerting.** A second copy on the same machine protects against a bad delete, a
      corrupted object or a botched upgrade; it does not protect against losing the
      host. Remaining: a mirror on another host, with `BACKUP_LOCAL_ADDRESSES` naming
      this one so the metric can prove it.
- [x] **A restore drill, performed and recorded** — `scripts/restore-drill.sh`
      (2026-09-20): seed mode, dump mode, refusal of a non-Signara dump, and then a
      **production dump fetched back out of the ONYX mirror and restored on the
      deployment host** (3 organizations, 3 users, 12 documents, 105 audit rows).
      Recorded with its limits in `docs/DisasterRecovery.md` §4.
- [x] **The drill runs on a schedule** — `.github/workflows/restore-drill.yml`
      (2026-09-20) runs seed mode monthly and keeps the log as an artifact, so the
      restore path is exercised between operator drills rather than only when someone
      remembers to run it.
- [~] Monitoring on the api/web/queue — **Prometheus and Alertmanager now run on
  the host (2026-09-20); delivery is still open.** All three scrape targets are
  up (`signara-api`, `signara-backup`, `prometheus`) and the rules evaluate: the
  only alert firing is `BackupIsLocalOnly`, which is the correct reading, not a
  false positive. Starting it exposed two defects, both fixed: the MinIO scrape
  job could only ever be down (the store is retired and profile-gated), so
  `StorageEndpointDown` was a permanent false critical; and `alertmanager.yml`
  used `${SMTP_PASSWORD}` against `smtp.example.com`, which Alertmanager cannot
  expand — `amtool check-config` reported SUCCESS on it while the receiver sent
  nowhere. The config is now rendered from `.env` at container start.
  **Still open: a destination.** The estate has no working mail path — every
  `SMTP_HOST` across the stacks is empty, no relay credentials exist, and
  outbound port 25 is blocked, so direct-to-MX delivery is impossible and the
  container warns that it cannot deliver. Alerts are visible in the Alertmanager
  UI (loopback, unauthenticated) meanwhile. Needs an authenticated relay on 587
  or a webhook; then set `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` and
  `ALERT_EMAIL_TO`.
- [x] **An upgrade path written down** — `docs/Deployment.md` §6 (2026-09-20).
      Its original reading was **wrong and has been corrected**: the deployment did
      run registry images (both containers carried `RepoDigests` into images CI
      built on 2026-09-07), not a host build — the earlier check inspected image
      names that did not exist on the host and concluded "no `RepoDigests`" from
      that. The real defect was in CI: `docker-build.yml` passed no
      `NEXT_PUBLIC_*` build args, so the published web image inlined the
      Dockerfile's `localhost` defaults and every deployment of it was broken in
      the browser. Fixed, with smoke-test coverage; the host now runs a host build
      of current `main` instead. §6.1 and §6.2 are the two routes (host build, or
      pin `sha-<commit>` and pull); §6.3–§6.5 cover forward-only migrations,
      verification, and rollback.

**Exit:** the restore drill is a dated entry in the DR doc, not a plan — **met,
including against a production dump on the deployment host.** What remains is
durability rather than procedure: (1) the mirror has to leave this host, and (2)
monitoring delivery — the stack now runs, but nothing can be sent anywhere until a
relay exists (see the monitoring item above). The upgrade path is written
(`docs/Deployment.md` §6). Until the mirror is off-host, the RTO of
≤ 4 h is an estimate for anything that takes the machine with it.

## 4. Phase plan

| Phase                  | Scope                                                              | Status                                                                                                                                                                                                                                                                                                                                               | Exit criteria                                                                       |
| ---------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **P0 — Freeze legacy** | sign-platform stable fallback + backups                            | **Moot** — the host is gone; nothing to freeze                                                                                                                                                                                                                                                                                                       | replaced by §6 recovery attempt                                                     |
| **P1 — Parity**        | W1 + W2                                                            | **In progress**                                                                                                                                                                                                                                                                                                                                      | every parity row shipped/decided/scheduled; verify script green                     |
| **P2 — Onyx**          | W3                                                                 | **Done 2026-09-15** — SigV4 shipped and deployed, 12 objects migrated and verified, MinIO demoted                                                                                                                                                                                                                                                    | a presigned fetch through the edge returns the recorded checksum with MinIO stopped |
| **P3 — Migration**     | W4                                                                 | **Conditional on §6**                                                                                                                                                                                                                                                                                                                                | counts reconcile _or_ a recorded write-off                                          |
| **P4 — Cutover**       | W5                                                                 | **Done** (2026-09-15)                                                                                                                                                                                                                                                                                                                                | signers sign on Signara at `sign.innotel.us`                                        |
| **P5 — Retire legacy** | archive the `sign` repo, drop dead DNS/proxy hosts, final doc pass | **Done 2026-09-20** — locales harvested, the parity reference written (`docs/OpenSignParity.md`), duplicated tooling re-verified at the frozen tip, publishing workflows gated, **`innotelinc/sign` archived read-only** (tag `sign-platform-final`), the stale `api.sign.innotel.us` record removed, and **both OpenSign images deleted from GHCR** | nothing in the estate refers to OpenSign except history                             |

## 5. Next actions (ordered)

1. ~~Timebox the legacy-data recovery (§6)~~ — **done 2026-09-15: written off.**
   The sources checked and their results are in §6; P3's ETL is cancelled rather
   than pending.
2. ~~Write `signara/scripts/verify-sso.py`~~ — **done 2026-09-15**; it passes
   against the live deployment, which closes the last untested zone.
3. ~~File the W2 parity checklist as issues~~ — **done 2026-09-15**: issues
   #81–#92. The four decisions (bulk send, in-person signing, cloud-storage
   import, SMS/WhatsApp) are now `question` issues that need an owner's answer,
   not a default.
4. ~~Open the Onyx SigV4 work item and land it~~ — **done 2026-09-15**
   (`services/objectstore/sigv4.go`, `storage.contract.spec.ts` 6/6, and
   `sigv4_vectors_test.go` replaying AWS's published vector suite against it).
5. ~~**Run one restore drill**~~ — **done 2026-09-20**, including a production
   dump read back out of the mirror (`docs/DisasterRecovery.md` §4). **Still open:
   make the mirror a different host.** `BACKUP_S3_*` now points at ONYX and the job
   mirrors successfully, but ONYX runs on the deployment host, so
   `signara_backup_mirror_offhost` is 0 and `BackupIsLocalOnly` is telling the
   truth rather than crying wolf.
6. ~~**Cut storage over to Onyx**~~ — **done 2026-09-15**: 12 objects migrated
   and verified against `checksumSha256`, `SIGNARA_S3_*` points at the store,
   MinIO demoted to `legacy-storage` and stopped. See W3.
7. **Archive `sign` on GitHub** (P5) — follow `1-primary/sign/ARCHIVE.md`: tag the
   frozen commit, archive the repository read-only, and stop its
   image-publishing workflow (gated to manual dispatch on 2026-09-20; the two
   GHCR packages it published are an operator decision, ARCHIVE.md §6). The
   assets worth keeping are already out: the seven locale catalogs ship in
   `apps/web/public/locales/` and the vocabulary/mail/certificate reference the
   parity rows need is [docs/OpenSignParity.md](OpenSignParity.md).

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

| Finding                                                                        | Then                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.11` boots, or its disk can be attached                                       | P3 as originally planned: dump + `opensign-files` volume → ETL → Onyx `legacy/` prefix                                                                                                |
| An archive exists elsewhere (another host, cloud bucket, an operator's laptop) | P3 with the ETL written against the archive; verification report against `DocumentHash`                                                                                               |
| Neither                                                                        | **Record the write-off.** Signara starts clean; offer a documented import path (an operator can still hand over a PDF) and make sure nobody promises "your old envelopes are in here" |

### The recovery attempt — performed 2026-09-15, found nothing

The timebox was one pass of looking, and it is spent. What was checked:

| Source                                                        | Result                                                                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `192.168.1.11`                                                | No ICMP; `:3000`, `:8080`, `:27017` closed; **`:22` closed too**, so it is not a reachable host in any state, only an address                                                                                   |
| `mongodump` archives / `opensign-files` tarballs on this host | None. A filesystem-wide search for `*.tar.gz                                                                                                                                                                    | *.tgz | *.bson | *.dump | *.archive` matching sign/opensign/mongo found nothing of ours |
| The backup script                                             | `sign-platform-backup.sh` appears in the `sign` repo **only inside the convergence documents** describing it, never as a committed file — so its destination was never recorded anywhere a reader could find it |
| A network share or NAS                                        | No NFS/CIFS/SMB mount on this host                                                                                                                                                                              |
| Retention                                                     | The documented retention was **14 days** from the first verified run on 2026-09-09, so even a surviving archive would have aged out around 2026-09-23                                                           |

**Decision: written off.** The P3 ETL is therefore not written — an ETL with no
source is a liability, not progress. If an operator turns up a copy later, this
table is the place to record it and P3 reopens.

What Signara owes users instead, so the write-off is not silent:

1. Say it in the launch note: **documents created on the previous platform are
   not in Signara.** No wording that implies otherwise.
2. Keep a documented way to bring a finished document in by hand, so an operator
   holding a PDF can still attach it to a record.

The reason this is a risk at all is that the last migration's durability depended
on an unversioned script on a single box. The remediation is §W6: a backup target
that is a different host, and a restore drill that has actually been run.

## 7. Risks

- **A second silent data loss.** Halved, not closed: the restore path is now
  rehearsed (`scripts/restore-drill.sh`, §W6) and local-only backups are an alert
  rather than a log line, so the failure would at least be visible. What remains is
  the part that actually decides survival — **a mirror on another host**, and one
  drill against a production dump. Until a target is configured, losing this host
  still loses the data.
- ~~**Onyx's SigV4 milestone slips.**~~ Cleared: SigV4 landed and the contract
  test passes against it. The residual risk is the **data copy** — moving
  existing objects into Onyx and proving the count, which is a migration chore
  rather than a blocker.
- **Parity by assumption.** The checklist above is an inventory of API surface,
  not of user expectations. Rows marked "decide" need a decision from the owner,
  not a default.
- **Two billing systems.** Signara has a `billing` module; the estate's rule is
  Magnate owns revenue. Resolve deliberately or it will drift into a second
  source of truth.
- **Public-name sprawl.** Every alias is another gated, certified, monitored
  surface; the estate just spent a day closing exactly those.

## 8. Decisions needed

1. ~~**Legacy data:** timebox the recovery, or write it off now?~~ — **settled
   2026-09-15: written off** (§6), after the recovery pass found nothing.
2. **Parity rows marked "decide"** — bulk send, in-person signing, cloud-storage
   imports, SMS/WhatsApp, i18n: ship or explicitly out of scope?
3. **Billing:** Signara's module as a Magnate client, or removed?

---

_Companion docs: `docs/Architecture.md`, `docs/Deployment.md`,
`docs/Security.md`, `docs/DisasterRecovery.md`,
`docs/OpenSignParity.md` (the harvested parity reference);
`1-primary/sign/CONVERGENCE.md` (v1 history and the data mapping tables);
`ips/docs/sign-in-posture.md` (the estate sign-in posture these workstreams plug
into)._
