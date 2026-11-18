# Self-healing

`restart: unless-stopped` covers a process that **exits**. It cannot cover a
container that stays `running` and stops serving, and that is the failure this
stack actually had — for two days.

## What happened

Between 2026-11-15 and 2026-11-18 `signara-postgres-1` was `running (unhealthy)`
with **empty logs**, and `signara-api-1` crash-looped behind it:

```
PrismaClientInitializationError: P1001
Can't reach database server at `postgres:5432`
```

Two layers, and the second hid the first.

**1. The container was not allowed to signal its own processes.** Under nested
incus the container's AppArmor peer label is namespaced
(`docker-default//&unconfined`), while the stock `docker-default` profile permits
a signal only to a peer named exactly `docker-default`. The kernel recorded it:

```
apparmor="DENIED" operation="signal" namespace="root//incus-signara_<var-lib-incus>"
profile="docker-default" pid=… comm="postgres" requested_mask="send"
signal=urg peer="docker-default//&unconfined"
```

Directly, that produced:

```
FATAL:  could not signal for checkpoint: Permission denied
pg_ctl: could not send stop signal (PID: 53): Permission denied
```

**2. The symptom pointed at the wrong thing.** The postgres image's root
entrypoint drops privileges with `gosu`. `gosu` is a Go program, and a Go
privilege drop signals its own threads; denied, it retried forever at ~98% CPU
and **never `exec`ed postgres**. So the container had no server, no log lines,
and PID 1 was `gosu` — a `running` container, which means the restart policy
never fired. The healthcheck reported `unhealthy` every 5s for two days and
nothing acted on it.

The data was never in danger, and the fault was never the uid: the same volume
starts and serves as soon as signals are permitted.

## The fix

`infra/apparmor/docker-default-signara` — a profile **named** `docker-default`, in
complain, that permits the operations the daemon's containers actually perform,
so the stacked peer label matches and a container may signal itself. Installed to
`/etc/apparmor.d/` and selected from the daemon's own config
(`infra/docker/daemon.json`, key `apparmor-profile`). This is the same posture
`monarch` runs; complain audits denials instead of enforcing them, so nothing is
silently allowed.

```sh
install -m 0644 infra/apparmor/docker-default-signara /etc/apparmor.d/docker-default-signara
apparmor_parser -r /etc/apparmor.d/docker-default-signara
grep docker-default /sys/kernel/security/apparmor/profiles    # docker-default (complain)
install -m 0644 infra/docker/daemon.json /etc/docker/daemon.json
systemctl restart docker        # live-restore keeps the running containers up
```

New containers get the new profile; existing ones keep the label they were
created with, so anything that was already wedged has to be recreated once.

Verified on 2026-11-18 after the change:

| Check | Result |
|---|---|
| `pg_isready` | `accepting connections` |
| `psql -c 'CHECKPOINT;'` | `CHECKPOINT` |
| `psql -c 'SELECT count(*) FROM information_schema.tables;'` | `245` |
| `docker restart signara-postgres-1` then wait | `healthy`, clean recovery |
| `curl 127.0.0.1:8002/ready` | `200`, `{"status":"ok","info":{"postgres":{"status":"up"}}}` |

## The healer

`scripts/self-heal.sh`, driven by `signara-self-heal.timer` (every 2 min, and
120s after boot):

| Found | Action |
|---|---|
| container missing, exited, created, dead | `up -d --no-deps <service>` |
| running, healthcheck `unhealthy` for ≥3 consecutive checks | `up -d --force-recreate --no-deps <service>` |
| `migrate` exited non-zero | re-run `up -d --no-deps migrate` |
| healthcheck `starting` | nothing — a slow boot is not a fault |

It walks dependencies first (`postgres`, `redis`, `meilisearch`, `migrate`,
`api`, `frontend`, then the monitoring services), then **asserts** readiness
rather than trusting health status: `pg_isready` inside the postgres container
and `/ready` inside the API. It exits non-zero if either still fails, so a heal
that did not work is a failed unit in `systemctl --failed`, not a quiet line in
a log.

It never runs `docker compose down`, never passes `--volumes`, and never
recreates a healthy container. A heal is a restart; no data is touched.

```sh
systemctl list-timers signara-self-heal.timer
journalctl -t signara-self-heal -n 40          # what it repaired, if anything
systemctl start signara-self-heal.service      # run it now
bash scripts/self-heal.sh --check              # report only, change nothing
bash scripts/self-heal.sh --verbose            # what every service looked like
```

## What it does not cover

- **Bad application code**, wrong credentials, or a failing migration: the healer
  restarts, and a restart cannot fix a bug. Those surface as a container that is
  recreated on every run; the journal names the service each time.
- **A healthcheck that lies.** The healer trusts the healthcheck to define
  "serving". `postgres`'s `pg_isready` and the API's `/ready` are honest, but a
  service with a shallow probe could be recreated forever without improving.
- **The host**, including this AppArmor profile. It runs inside the `signara`
  container and cannot fix the Incus container, the Docker daemon, or the profile
  the daemon loaded. A host-level fault shows up as every repair failing, which
  the unit's exit status reports. This is precisely why the signal denial above
  would not have healed itself: the diagnosis, not the restart, was the fix.
- **Data loss.** It deliberately has no path that deletes a volume, so a corrupt
  database is restored from `infra/backup`, not self-healed.
