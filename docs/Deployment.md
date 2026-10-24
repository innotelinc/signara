# Signara - Deployment Guide

This guide documents the supported operator-run Docker Compose deployment for a
self-hosted Signara installation, plus optional NGINX Proxy Manager automation.
GitHub Actions do not connect to or deploy the host.

1. [Docker Compose](#1-docker-compose)
2. [DNS, TLS, and NGINX via Cerulean](#2-dns-tls-and-nginx-via-cerulean)
3. [Legacy direct NGINX automation](#3-legacy-direct-nginx-automation)
4. [Identity provider (Authentik)](#4-identity-provider-authentik)
5. [Certificate-backed signing](#5-certificate-backed-signing)
6. [Post-setup checklist](#6-post-setup-checklist)

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

The development stack exposes the web UI on `http://localhost:3010`, the API
on `http://localhost:8010`, Authentik on `http://localhost:9110`, MinIO on
`http://localhost:9005` (console `:9006`) and Prometheus on
`http://localhost:9091`.

Dev published ports are deliberately disjoint from the shared production
stack (which owns `:3000/:8000/:9000/:9002/:5432/:6379/:7700` and friends) so
the dev and prod stacks can run on the same host without port collisions.

### Production

```bash
git clone https://github.com/innotelinc/signara.git signara
cd signara
cp .env.example .env
# Edit .env and set production secrets and public URLs.
./setup.sh --production
```

`setup.sh --production` validates prerequisites, creates missing local secrets,
starts the production dependencies, applies migrations inside the Compose
network, and starts the stack. Add `--use-images` when you intentionally want to pull published GHCR images instead
of building API and web locally. Add
`--with-cerulean` to reconcile DNS, NGINX Proxy Manager hosts, and TLS through
Cerulean. DNS uses the persisted public WAN IP; NPM uses the host LAN IP.

The browser-facing entry points come from `.env`: `WEB_URL`/`APP_URL` (the web
app), `API_URL`, and `AUTH_URL`. Presigned document URLs are signed against
`S3_PUBLIC_ENDPOINT` (e.g. `https://storage.signara.innotel.us`) so browsers can
reach object storage directly instead of through the API. Since the cutover that
object storage is the estate's `onyx-objectstore`, and the `SIGNARA_S3_*`
variables in `.env` select it — see “Storage profile” below. The API derives its
CORS allowlist from `WEB_URL`/`APP_URL` — including the apex/parent domain of
those hosts and `localhost:3000` for development — and only needs
`CORS_ORIGINS` when an extra origin must be allowed.

### Operations

Always pass **both** files — the second one is not optional:

```bash
COMPOSE="docker compose -f docker-compose.prod.yml -f docker-compose.override.prod.yml"
```

| Task          | Command                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| View status   | `$COMPOSE ps`                                                               |
| API logs      | `$COMPOSE logs -f api`                                                      |
| Upgrade       | `git pull && ./setup.sh --production`                                       |
| Backup        | `$COMPOSE exec backup /backup/backup.sh`                                    |
| Restore       | `$COMPOSE exec backup /backup/restore.sh <file>`                            |
| Stop services | `$COMPOSE down`                                                             |
| Monitoring    | `$COMPOSE --profile monitoring up -d prometheus alertmanager`               |
| Metrics       | Prometheus `127.0.0.1:9090`, Alertmanager `127.0.0.1:9093`                  |

**Using `-f docker-compose.prod.yml` alone is a real footgun, not a shortcut on
this host.** `docker-compose.override.prod.yml` carries this deployment's
topology, and a bare `up -d` silently undoes two things at once:

- the `monitoring` profile stops applying, so Prometheus, Alertmanager and the
  backup containers (deliberately left down) get started by what looks like a
  routine command.
- nothing on the host is re-`build`-ed, so it is easy to believe the run was a
  no-op.

A container keeps its old config if a command does not recreate it, so this is
easy to miss: the damage only shows up on the _next_ recreate of that service.

#### Failed queue jobs

`QueueFailuresHigh` fires when more than 10 jobs enter a queue's failed set within
six hours, and it resolves by itself once they stop. That is deliberate: the gauge
it reads (`bullmq_queue_failed_count`, published by the API's queue-metrics poll)
counts jobs **retained** in the failed set, so the count only falls when someone
clears it — and an alert that needs manual clearing to go quiet is an alert that
keeps crying wolf after the problem is fixed. Clearing is a review step, not a
condition for silence:

```bash
REDIS_PASSWORD="$(grep '^REDIS_PASSWORD=' .env | cut -d= -f2-)"

# 1. Read it. Every failed job carries its reason, and the reason is the point:
#    on 2026-10-12 two real `send-signing-reminder` failures (the relay's
#    certificate, so *every* signing mail) sat behind 39 settled `sweep-reminders`
#    jobs from an older build, and "41 failed" as a bare count hid them.
$COMPOSE exec redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
  ZRANGE bull:signing:failed 0 -1 | while read -r id; do
    printf '%s: ' "$id"
    $COMPOSE exec -T redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
      HGET "bull:signing:$id" failedReason
  done

# 2. Then clear what is historical — one key per queue (`signing`,
#    `notifications`, `audit`). The gauge follows within a poll interval.
$COMPOSE exec redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning DEL bull:signing:failed
```

Clearing is not data loss: the jobs are already failed, and their effect — the
`Notification` row marked `FAILED`, the log line, the metric — is the record that
matters. What clearing buys is a gauge that means "this many jobs are failing
now" rather than "this many have ever failed".

All Compose services include health checks, restart policies, resource limits,
and bounded JSON logging. The API waits for PostgreSQL, Redis, and Meilisearch
before becoming ready — deliberately **not** on the object store, so that the
retired store can be stopped without the API refusing to boot.

### Monitoring and alerts

Prometheus, Alertmanager, and the backup jobs are behind the `monitoring`
profile, so a plain `up -d` leaves them stopped:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.override.prod.yml \
  --profile monitoring up -d prometheus alertmanager backup backup-metrics dns-probe
```

Prometheus and Alertmanager are published on **loopback only** by default.
Neither has authentication, and Prometheus's query API plus Alertmanager's
silence/alert list expose everything the stack collects, so they are deliberately
not reachable from the network; reach them with an SSH tunnel
(`ssh -L 9090:127.0.0.1:9090 …`) rather than through the edge. The one exception
to watch for is Alertmanager's bind address — a mail link is built from
`--web.external-url`, so publishing the port on the LAN is what makes a LAN link
there honest (see below).

**Critical** alerts are mailed to `ALERT_EMAIL_TO` over the same relay and login the
app's notification workers use (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`) —
but *not* the same sender. `SMTP_FROM` is the alerts identity and belongs to
Alertmanager; product mail (invitations, reminders, completion notices) sends as
`SMTP_PRODUCT_FROM`, which defaults to `Signara <no-reply@signara.innotel.us>`, or
to `SMTP_FROM` when it is unset. The two are deliberately separate variables: one
address serving both streams means a signer's invitation arrives from the alerts
mailbox and their replies land there, which is the thing `b5e0b65` set out to
avoid. Where a relay authorises only the mailbox it authenticated, the header and
the envelope differ on purpose — `SMTP_PRODUCT_FROM` is what the signer sees,
`SMTP_ENVELOPE_FROM` (default: `SMTP_USER`) is what the relay accepts — and
setting the envelope to anything the relay did not authenticate gets every
signing mail refused with `501 5.5.4 You are not allowed to send from this
address`.
A `warning` is evaluated and stays visible in the Alertmanager UI, but it is not
mailed: the route sends `severity != critical` to the `silent` receiver, because
the estate's periodic probes all fire as warnings and mailing each one trained the
reader to ignore the mailbox. The delivery probe (`EstateDeliveryProbe*`) is the
one exception, matched by name before that route: it goes to the `probe` receiver,
which mails `SMTP_USER` — the alerts account on the relay, not this human inbox —
and does not send a resolution. That is what keeps the receiver's live proof of
delivery (`check-alert-delivery.py` in `innotelinc/innotel-platform-stack`, which
reads the mail server's log rather than a mailbox) without paying for it with a
page: the 2026-10-20 attempt silenced the probe outright, which left the proof —
and the check that runs it — with nowhere to go. If the SMTP variables are unset the stack still
evaluates rules and shows them in the UI, and the container says so at start — but
nobody is told, so set them.

What the mail *says* comes from templates, not from Alertmanager's default body —
that default prints a bare `Labels` / `Annotations` dump and a `Source:` line,
which is what the estate's delivery-probe mail was arriving as.
`infra/monitoring/alertmanager/email.tmpl` is mounted read-only at
`/etc/alertmanager/email.tmpl` and referenced from `alertmanager.yml` (the
`templates:` list, plus the receiver's `html`, `text` and `Subject`): severity and
alert name in the subject, one block per alert, and a link back to the UI.

That link is built from `--web.external-url`. Left unset, Alertmanager advertises
the container's own hostname (`http://<container-id>:9093`), which resolves for
nobody; `docker-compose.prod.yml` passes `ALERTMANAGER_EXTERNAL_URL` (default
`http://192.168.1.44:9093`). Keep it in step with `ALERTMANAGER_BIND_ADDRESS`: the
compose default publishes 9093 on **loopback only**, so a link to the LAN address
resolves only while the port is published on it — this deployment sets
`ALERTMANAGER_BIND_ADDRESS=0.0.0.0` for exactly that reason, accepting that the
silence/alert list is then reachable from the LAN.

Alertmanager also has to say *who* it is: it speaks `EHLO` with the container's
hostname, which Go defaults to `localhost`, and a strict relay refuses a
single-label name (`Stalwart` answers `550 5.5.0 Invalid EHLO domain`). Set
`SMTP_HELLO` to a dotted FQDN (it defaults to `signara.innotel.us`) or delivery
fails after a connection that otherwise looks healthy.

If the relay offers `STARTTLS` with a certificate that does not name the address
dialled — an internal relay reached by IP, typically — the client refuses it
(`x509: cannot validate certificate for <ip>`, or nodemailer's "Hostname/IP does
not match certificate's altnames"). There are two answers and they are not
equivalent:

- `SMTP_TLS_SERVERNAME` names the certificate (and is the SNI offered), so the
  handshake is verified against the name the relay actually presents. This is
  the one to prefer, and it is what this deployment uses: Stalwart is reached at
  `192.168.1.15` while its certificate covers `*.innotel.us` and chains to a
  public CA, so naming it restores a *verified* connection.
- `SMTP_TLS_INSECURE=true` keeps `STARTTLS` and skips verification. It is the
  fallback for a relay whose certificate cannot be named into validity
  (self-signed, naming no address), not a way to make a template variable go
  away.

Both are read by the API *and* by Alertmanager, but they are configured per
service on purpose: the API deciding to skip verification for product mail says
nothing about the alert path, and vice versa. `SMTP_TLS_INSECURE=false` with an
empty `SMTP_TLS_SERVERNAME` and a relay dialled by IP is a config that will
refuse to send — the Alertmanager entrypoint warns about exactly that at start.

Note which relay you can actually use: hosts that block outbound port 25 cannot
deliver mail directly to a recipient's MX, so this needs an **authenticated relay
on 587 (or 465)**. `ALERT_EMAIL_TO` addresses a real mailbox; the previous
`platform-critical@`/`platform@`/`oncall@` addresses were never provisioned, so
critical alerts were addressed to nowhere.

The estate resolves this with its **own** mail server rather than an external
relay: Stalwart on `192.168.1.15`, which the other stacks use too. Point
`SMTP_HOST`/`SMTP_PORT` at its submission port (`192.168.1.15:587`) and set
`SMTP_USER`/`SMTP_PASS` to a mailbox it serves — this deployment uses
`alertmanager@innotel.us` — with `ALERT_EMAIL_TO` also on a domain it serves
(`admin@innotel.us`). Authentication over `STARTTLS` is what that port expects;
both the handshake and the login were confirmed against it. Its certificate is a
real one covering `*.innotel.us` (measured 2026-10-12, after the relay replaced
its earlier self-signed certificate), so this deployment sets
`SMTP_TLS_SERVERNAME=innotel.us` and verifies: the connection is to a LAN
address, but the certificate is checked against the name it presents. A relay
whose certificate genuinely cannot be named — self-signed, naming no address —
is the only case for `SMTP_TLS_INSECURE=true`.

Stalwart also authorises the *envelope* per authenticated mailbox: it answers
`501 5.5.4 You are not allowed to send from this address` for a `MAIL FROM` it
did not authenticate. That is why the product's own sender is expressed as a
header (`SMTP_PRODUCT_FROM`), with `SMTP_ENVELOPE_FROM` staying the mailbox the
deployment logs in as. Giving the product a submission account of its own — a
`signara.innotel.us` mailbox, the domain already carrying its own DKIM keys —
would let the envelope match the header, and is the next step if the sender
identity ever needs to survive a change of relay.

`infra/monitoring/alertmanager/alertmanager.yml` is a template: Alertmanager has
no environment expansion, so `entrypoint.sh` substitutes it at container start and
refuses to start if a placeholder is left behind. Editing the mounts to point
Alertmanager straight at the file would silently restore the bug it exists to fix.

### Storage profile

Documents live in an S3-compatible store selected entirely from `.env`. Moving
stores is a configuration change, not a code change.

| Variable                                          | Purpose                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| `SIGNARA_S3_ENDPOINT`                             | Where the API reads and writes. Currently `http://172.17.0.1:2090`. |
| `SIGNARA_S3_BUCKET`                               | Bucket holding document objects (default `signara-documents`).      |
| `SIGNARA_S3_ACCESS_KEY` / `SIGNARA_S3_SECRET_KEY` | Credentials for that store.                                         |
| `SIGNARA_S3_PUBLIC_ENDPOINT`                      | Host that browser-facing presigned URLs are signed for.             |

`S3_*` **without** the prefix is a different thing: MinIO's own root credentials,
left untouched so the retired store can be started again for a rollback. Compose
maps `SIGNARA_S3_*` onto the `S3_*` names the API reads, and `environment` wins
over `env_file`.

To move stores — copy first, which verifies every object byte for byte before
anything is pointed at it:

```bash
SOURCE_S3_ENDPOINT=http://…:9002 SOURCE_S3_ACCESS_KEY=… SOURCE_S3_SECRET_KEY=… \
TARGET_S3_ENDPOINT=http://…:2090 TARGET_S3_ACCESS_KEY=… TARGET_S3_SECRET_KEY=… \
  node scripts/migrate-object-store.mjs --apply
```

Then change `SIGNARA_S3_*` and run
`docker compose -f docker-compose.prod.yml -f docker-compose.override.prod.yml up -d --no-deps api`.
Verify the store itself with `scripts/onyx-objectstore-smoke.sh` (plain REST, no
client library in the way) and `scripts/onyx-s3-test.mjs` (a real S3 SDK); verify
the _browser_ path by presigning an object for `SIGNARA_S3_PUBLIC_ENDPOINT` and
fetching it through the edge, then comparing it to the document's
`checksumSha256`.

### Backups

The production stack includes a backup container for PostgreSQL, the identity
database, and the object store the API actually uses. Each run writes database
dumps and an object archive to the persistent `backupcache` volume. Configure all
`BACKUP_S3_*` variables for an off-host mirror and `BACKUP_RETENTION_DAYS` for
retention; set `BACKUP_REQUIRE_REMOTE=true` so a missing mirror **fails** the run
instead of downgrading it to local-only.

The identity database is **not** part of this job. In this estate Authentik
belongs to Cerulean and lives on Cerulean's host, so Cerulean dumps it there
(`1-primary/cerulean/scripts/authentik-db-backup.sh`); this stack used to reach
it by joining Cerulean's docker network, which only ever worked while both ran
on one host. The dump is dumped when `AUTHENTIK_POSTGRES_PASSWORD` is set — the
switch that keeps a self-contained deployment from failing every run against a
database it does not have.

What the stack *is* configured for is published rather than assumed:
`IDENTITY_EXPECTED` is 1 only when that password is set, and
`signara_backup_identity_expected` reports it. `IdentityDatabaseNotBackedUp` is
gated on it, so a run that is meant to cover the identity plane and does not
still alerts, while a host that rightly leaves the job to Cerulean stays quiet —
the documents and the logins that reach them are protected by two jobs on two
hosts, each reporting on its own.

A mirror is required, not optional: the `backupcache` volume sits on the host whose
database it protects. Whether that mirror is _somewhere else_ is what
`signara_backup_mirror_offhost` reports and `BackupIsLocalOnly` alerts on —
`remote_enabled` says only that credentials were configured, and a mirror on the
same host reads as a success while adding no durability. Off-host is proven rather
than assumed: the job resolves the mirror endpoint and compares it against
`BACKUP_LOCAL_ADDRESSES`, which has to list this host's addresses. This deployment
mirrors to a dedicated `onyx-objectstore` on `192.168.1.60:2091` (host `onyx`), whose storage is
a host bind mount — a target inside a docker named volume (an `e2e` store) would
be deleted by the next `down -v` while still reporting green. Object
transfers to and from the mirror use `rclone`, because ONYX refuses the streaming
SigV4 payloads `mc` sends for every PUT. Verify durability with
`scripts/restore-drill.sh` (Docker-only, non-destructive — it uses its own
throwaway containers) and record the run in [DisasterRecovery.md](DisasterRecovery.md) §4.

## 2. DNS, TLS, and NGINX via Cerulean

Cerulean is the recommended automation path. It owns the DNS record updates,
NGINX Proxy Manager reconciliation, wildcard certificate issuance/renewal, and
certificate attachment. DNS A records for Signara hosts always use the public
WAN IPv4 address. NPM upstreams use the host LAN IPv4 address so NPM can reach
the API, web, storage, Authentik, and admin ports; Docker bridge addresses are rejected.
The two addresses are deliberately separate.

Set these values in `.env`:

```bash
CERULEAN_DNS_API_URL=http://localhost:3003
CERULEAN_SERVICE_KEY=<scoped ceru_… key>   # see "Credentials" below
CERULEAN_ADMIN_PASSWORD=<cerulean-admin-password>
CERULEAN_BASE_DOMAIN=signara.innotel.us
CERULEAN_ZONE=signara.innotel.us   # the zone that HOLDS the records — not its parent
CERULEAN_LAN_IP=192.168.1.71   # NPM upstream only; replace with host LAN IPv4
CERULEAN_WAN_IP=73.68.203.71   # last verified WAN value; DNS only
CERULEAN_WAN_DISCOVERY_URL=https://api.ipify.org
```

**Credentials.** Two exist and the script prefers the service key:

- `CERULEAN_SERVICE_KEY` — the scoped `ceru_…` key, presented against Cerulean's
  `/api/service` bridge. This is the only **non-interactive** path once Cerulean
  disables password sign-in, which it does when Authentik owns identity (the case
  on this estate: `POST /api/auth/login` answers *"Password sign-in is disabled —
  sign in with Authentik"*). The scopes decide what a run can do. The
  `signara-dns` key holds `dns:read`, `dns:write`, `domains:read` and `certs:read`,
  so it reconciles records and nothing else — pass `--dns-only`, which states that
  rather than letting the other steps be skipped quietly.
- `CERULEAN_ADMIN_PASSWORD` — Cerulean's own sign-in, for what a service key
  cannot do: create a zone, issue or renew a certificate, reconcile NPM hosts.

Preview the reconciliation:

```bash
python3 infra/cerulean/provision.py --dry-run --dotenv .env
```

Apply it during setup or independently:

```bash
./setup.sh --production --with-cerulean
# or
make cerulean-provision
# DNS only, with the scoped key (what this estate uses):
python3 infra/cerulean/provision.py --dns-only \
  --zone signara.innotel.us --base-domain signara.innotel.us
```

The checked-in map at `infra/cerulean/hosts.conf` provisions:

| Hostname                       | DNS A record | NPM upstream                |
| ------------------------------ | ------------ | --------------------------- |
| `app.signara.innotel.us`       | WAN IP       | LAN IP `:3000`              |
| `api.signara.innotel.us`       | WAN IP       | LAN IP `:8002`              |
| `auth.signara.innotel.us`      | WAN IP       | LAN IP `:9000`              |
| `admin.signara.innotel.us`     | WAN IP       | `127.0.0.1:4180` (SSO gate) |
| `storage.signara.innotel.us`   | WAN IP       | LAN IP `:2090`              |
| `subscribe.signara.innotel.us` | WAN IP       | LAN IP `:3040`              |

Every upstream here has to stay equal to what the host actually binds, because
a re-provision rewrites the edge to match this file — it is not documentation,
it is input. The API's port is `8002`, not `8000`: `:8000` belongs to the voice
plane (`dograh-api`) on this host, and the API itself binds `8002`
(`API_BIND_PORT` in `.env`). `auth` is Cerulean's Authentik on `:9000`, not this
stack's profile-gated `authentik` service (which would be `:9100`); the
federated posture puts identity in the trust layer, so the edge points there.
`admin` is NPM's own administration UI behind Cerulean's SSO gate —
oauth2-proxy on `127.0.0.1:4180` — which is why that entry is the one that names
its own `upstream-host`: the LAN address cannot reach loopback, and pointing the
door at `:81` would serve the raw admin UI with the gate removed.

`storage` backs the browser-facing presigned document URLs (`S3_PUBLIC_ENDPOINT`),
served by the estate's `onyx-objectstore`, reached on the host's LAN address
`:2090`. `subscribe` is served under this zone but owned by `ips`, so it is
listed only so provisioning leaves it correct rather than guessing.

On every normal provisioning run, Cerulean redetects and validates the current
public WAN IPv4, persists it as `CERULEAN_WAN_IP`, and uses it for DNS. The script
then resolves the zone named by `CERULEAN_ZONE` and reconciles exactly one WAN A
record per Signara hostname. The wanted record is created **before** anything else
is removed, because the reverse order has a failure mode this estate has already
paid for: an error between deleting and creating leaves the hostname with no
address at all, while the zone, the edge and the certificate all still look
healthy. It then creates or updates the NPM hosts with the upstreams above (a
per-entry `upstream-host` overriding `CERULEAN_LAN_IP`), and issues or reuses the
`*.signara.innotel.us` wildcard certificate. Unrelated records in the zone are
never removed. Certificate renewal and NPM attachment remain managed by Cerulean.

**`CERULEAN_ZONE` must name the zone that actually holds the records — on this
estate `signara.innotel.us`, not `innotel.us`.** A zone named after the base
domain shadows its parent for every name beneath it, because a nameserver answers
from the most specific zone it holds: records written to `innotel.us` would exist
and resolve for nobody. The script refuses that combination and names the zone to
use instead; `--allow-shadowed-zone` overrides it only when the child zone is
being retired deliberately.

**Before trusting a provisioning run, dry-run it against the deployment:**
`python3 infra/cerulean/provision.py --dotenv .env --dry-run` must print
`unchanged` for every host. If it prints `update` or `create`, the map disagrees
with the live edge — fix the map, not the reflex to re-run it. `make
cerulean-provision` and `CERULEAN_AUTO_PROVISION=true` (which `setup.sh`
honours) both apply it for real.

### When a Signara hostname stops resolving

The failure mode this estate hit on **2026-10-15**: `app.signara.innotel.us` (and
every other Signara name) returned `DNS_PROBE_FINISHED_NXDOMAIN` while the API, the
web app, the edge and the certificate were all healthy. The stack was fine — the
**A records were gone from the zone**. Work through it in this order.

**1. Confirm it is the name, not the stack.** Ask the nameserver directly, and
check the app over its loopback port:

```bash
for h in signara.innotel.us app.signara.innotel.us api.signara.innotel.us \
         auth.signara.innotel.us storage.signara.innotel.us; do
  printf '%-34s ' "$h"; dig +short "$h" @192.168.1.71; done
# no dig? python3 -c "import socket; print(socket.gethostbyname('app.signara.innotel.us'))"
curl -s -o /dev/null -w 'loopback web: %{http_code}\n' \
  -H 'Host: app.signara.innotel.us' http://192.168.1.44:3000/
```

An empty answer for a name the app is serving *is* this outage. A 200 from the
loopback check proves the problem is purely the name.

**2. Read the zone the records live in.** `signara.innotel.us` holds them; its
parent `innotel.us` does not, and never has:

```bash
KEY="$(grep '^CERULEAN_SERVICE_KEY=' .env | cut -d= -f2-)"
curl -s -H "Authorization: Bearer $KEY" \
  'http://192.168.1.71:3003/api/service/dns/records?zone=signara.innotel.us'
```

Expect one A record per host plus the zone root, all pointing at
`CERULEAN_WAN_IP` (`73.68.203.71`). The mail records — DKIM (`v1-rsa-…`,
`v1-ed25519-…`), `_mta-sts`, `_imaps`/`_submissions` and friends — live in the
same zone and must not be touched: **deleting the zone to "start clean" destroys
them and breaks `signara.innotel.us` mail authentication.**

**3. Restore the records.** Provisioning does it with the scoped key, no admin
password needed, and stops on its own if it is pointed at the wrong zone:

```bash
python3 infra/cerulean/provision.py --dns-only \
  --zone signara.innotel.us --base-domain signara.innotel.us
```

**4. Verify through the interface a user has**, not the zone file:

```bash
curl -fsS -o /dev/null -w 'app %{http_code}\n' https://app.signara.innotel.us/
curl -fsS -o /dev/null -w 'api %{http_code}\n' https://api.signara.innotel.us/ready
```

Until the negative cache expires browsers may keep the old `NXDOMAIN` for the
zone's 900 s minimum — `ipconfig /flushdns` on Windows.

`SignaraHostnameNotResolving` (`infra/monitoring/prometheus/rules.yml`, fed by
`infra/monitoring/dns_probe.py`) is the alert for step 1: it fires when a probe of
these names stops matching `CERULEAN_WAN_IP`, so the next occurrence arrives as an
alert instead of a user's report. Note that provisioning will *not* recreate a
deleted record on its own — it reads the current records to decide whether a host
is `unchanged`.

## 3. Legacy direct NGINX automation

The direct script remains available for installations that do not run Cerulean.
It drives NPM directly and uses Cloudflare + Let's Encrypt DNS-01 credentials;
it does not enforce the Cerulean WAN-DNS/LAN-upstream workflow.

### DNS and TLS via NGINX Proxy Manager

The automation at `infra/nginx/npm-proxy-hosts.py` creates or updates proxy
hosts and can request the wildcard certificate. Run it directly or through
`./setup.sh --with-nginx`.

| Hostname                     | Backend                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `app.signara.innotel.us`     | web `:3000`                                               |
| `api.signara.innotel.us`     | api `:8002` (`API_BIND_PORT`; `:8000` is the voice plane) |
| `auth.signara.innotel.us`    | Cerulean's Authentik `:9000`                              |
| `admin.signara.innotel.us`   | NPM admin UI behind the SSO gate (`127.0.0.1:4180`)       |
| `storage.signara.innotel.us` | onyx-objectstore `:2090` (container `:9000`)              |

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
storage.signara.innotel.us A <proxy-host-ip>
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

### Login round-trip (app vs api host)

The web app lives on `app.<domain>` and the API on `api.<domain>`. The OIDC
callback runs on the API and must land the browser back in the **web app**, and
the session cookies must be visible on **both** subdomains so the app's
server-side `layout.tsx` can read `signara_access`:

- The callback redirects to `WEB_URL` (default `https://app.signara.innotel.us`)
  instead of a raw path on the API host (which returned a NestJS 404 page).
- Auth cookies (`signara_access`, `signara_refresh`, `signara_oidc_state`) are
  set with `Domain` derived from `API_URL` (e.g. `.signara.innotel.us`), so the
  app subdomain receives them. Set `COOKIE_DOMAIN` explicitly to override;
  leave empty for bare hosts/IPs (local dev).

Verify with a real browser: sign in at `https://app.signara.innotel.us` →
you land back on the dashboard, not an API error page.

## 5. Certificate-backed signing

The API supports ACME, Cerulean, and internal PKI providers. Private key
material is encrypted at rest with `CRYPTO_MASTER_KEY`; do not rotate that key
without re-encrypting existing certificate records.

Configure provider settings in `.env`, then use the certificate endpoints under
`/api/v1/certificates`. Provider-held keys remain outside Signara and imported
keys are verified against their certificates before storage.

SMTP configuration is optional in local development. Set `SMTP_HOST`,
`SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` to enable
invitation, reminder, and notification delivery. `SMTP_PRODUCT_FROM` (default:
`Signara <no-reply@signara.innotel.us>`) is the address signers see, and
`SMTP_ENVELOPE_FROM` (default: `SMTP_USER`) is the envelope the relay authorises;
`SMTP_TLS_SERVERNAME` names the relay's certificate when it is dialled by an
address the certificate does not carry.

## 6. Upgrading an existing deployment

Start by reading what is actually running, because the tag does not say where
the artifact came from. Both routes below have been used on this host:

- **Registry pull — what ran until 2026-09-20.** `signara-api-1` and
  `signara-frontend-1` both carried `RepoDigests` pointing at images CI built on
  2026-09-07, so they were pulled rather than built here.
- **Host build — what runs now.** Those pulled images had been built by
  `docker-build.yml` _without_ the web image's `NEXT_PUBLIC_*` build args, so the
  Dockerfile's `http://localhost` defaults were inlined into the client bundle:
  the landing page's sign-in link and the signing room's session fetch both
  resolved to `localhost:8000`, and the demo could not open a session. §6.1 is the
  route that fixed it, and it is what this host runs as of `5bf05bc`.

The workflow now passes those args, so the next released image should be usable.
Until one is published, an upgrade here is a rebuild, not a pull.

Pick one route and stay on it. Mixing them is how a host ends up running a build
nobody can name.

### 6.1 Host build (what is deployed today)

```bash
cd /usr/src/projects/complete/1-primary/signara
COMPOSE="docker compose -f docker-compose.prod.yml -f docker-compose.override.prod.yml"

# 1. Name what you are leaving behind, so rollback is a retag and not a rebuild.
docker tag ghcr.io/innotelinc/signara-api:latest signara-api:rollback-$(date +%Y%m%d)
docker tag ghcr.io/innotelinc/signara-web:latest signara-web:rollback-$(date +%Y%m%d)

# 2. Back up first. A migration is the one step a rollback cannot undo.
make backup

# 3. Code and images.
git pull --ff-only
$COMPOSE build api frontend migrate

# 4. Schema, then the long-running services.
$COMPOSE run --rm migrate           # prisma migrate deploy, once
$COMPOSE up -d --no-deps api frontend
```

### 6.2 Registry artifacts (pin what you run)

Set both images in `.env` and the upgrade becomes a pull:

```bash
SIGNARA_API_IMAGE=ghcr.io/innotelinc/signara-api:sha-<commit>
SIGNARA_WEB_IMAGE=ghcr.io/innotelinc/signara-web:sha-<commit>
```

CI publishes `sha-<commit>` for every build, version tags on `v*`, and a moving
`latest`. **Pin to `sha-<commit>` or a version tag, not `latest`:** pinning is what
makes "this deployment is running X" a claim `docker inspect` can check, and it is
what makes rollback a variable change rather than a rebuild. Then:

```bash
$COMPOSE pull api frontend migrate
$COMPOSE run --rm migrate
$COMPOSE up -d --no-deps api frontend
```

### 6.3 Migrations

- `migrate` runs `prisma migrate deploy` against the API image — the same schema
  the API expects, applied before the new API starts. Keep that order.
- Migrations are **forward-only**: Prisma has no down-migrations, so a bad one is
  undone by restoring the pre-upgrade dump, not by a reverse migration. That is
  why §6.1 runs the backup first, and why `BackupStale` is worth reading before
  an upgrade.
- Stop `api` and `frontend` (`$COMPOSE stop api frontend`) when a migration
  rewrites or drops data: a one-shot migration while the old API is serving is
  the state that produces half-migrated reads.
- Never `prisma migrate reset`, `db push` or `--force-reset` in production. They
  drop the database, and the dump is the only thing that would bring it back.
- **A migration is not the whole upgrade.** The RBAC catalog (`Permission`,
  `Role`, `RolePermission`) is data, seeded by `packages/database/prisma/seed.ts`
  — so a release that adds a permission silently locks the new routes out until
  the seed runs. It cannot run on the host: `tsx` and the seed's dev dependencies
  are pruned from the API image, and `migrate` runs only `prisma migrate deploy`.
  Either run `npm run db:seed:rbac -w @signara/database` from a dev checkout
  against this database, or apply the same rows by hand — the seed is an upsert,
  so it agrees with a manual insert (`webhooks.manage` for #85 was applied this
  way, granted to `ORGANIZATION_OWNER` and `ADMINISTRATOR`).

### 6.4 Verify, then record

1. `$COMPOSE ps` — `api`, `frontend`, `postgres`, `redis`, `meilisearch` healthy.
2. `curl -fsS https://api.signara.innotel.us/ready`.
3. `.github/workflows/smoke-test.yml` (signing round-trip through the edge).
4. After any schema change, run `scripts/restore-drill.sh --dump <fresh dump>` and
   record it in [DisasterRecovery.md](DisasterRecovery.md) §4. A rollback restores
   an _older_ dump into the current schema, and that is the path a drill proves.

### 6.5 Rolling back

Retag or re-point the two services and recreate them — `up -d --no-deps api
frontend` with the previous image ref — then repeat §6.4. Restore the dump **only**
if a migration was applied: restoring over a healthy database to undo an
application change loses every write since the dump for no reason.

## 7. Post-setup checklist

- [ ] `https://api.signara.innotel.us/ready` returns a healthy response
- [ ] OIDC login round-trip works with MFA
- [ ] PDF upload and document download work
- [ ] Sequential and parallel signing flows complete
- [ ] Evidence reports include hashes, timestamps, and audit events
- [ ] Prometheus is scraping the API and backup metrics (`up` for both targets)
- [ ] Backup job completes and a restore drill is recorded
- [ ] NGINX Proxy Manager certificates renew successfully
