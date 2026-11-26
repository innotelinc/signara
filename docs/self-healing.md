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
| paused (frozen by the cgroup freezer) | `docker unpause`, then `up -d --force-recreate --no-deps` — `up -d` cannot start a paused container, so the start branch above provably does not work here |
| running, healthcheck `unhealthy` for ≥3 consecutive checks | `up -d --force-recreate --no-deps <service>` |
| `migrate` exited non-zero | re-run `up -d --no-deps migrate` |
| healthcheck `starting` | nothing — a slow boot is not a fault |
| AppArmor profile missing, drifted from `infra/`, or not loaded in complain | reinstall from `infra/apparmor/`, `apparmor_parser -r`, and restore `apparmor-profile` in the daemon config (restarting docker if it had to change) |

It walks dependencies first (`postgres`, `redis`, `meilisearch`, `migrate`,
`api`, `frontend`, then the monitoring services), then **asserts** readiness
rather than trusting health status: `pg_isready` inside the postgres container,
`/ready` inside the API, and the web app's HTML from `frontend`. Earlier
versions stopped after the API and still logged "frontend serving" without
asking it, which is the class of claim this page exists to avoid.

It finishes on `SMOKE_PUBLIC=0 scripts/post-deploy-smoke.sh` — the deploy gate's
own local checks, including restart counts and the port compose actually
published — so "healed" and "deployed" mean the same thing and a heal cannot be
contradicted by the next deploy. Public hostnames are excluded deliberately: the
edge and NGINX Proxy Manager live outside this container, and a heal cannot
repair them, so failing on them here would page for someone else's outage.

It exits non-zero if any of that still fails, so a heal that did not work is a
failed unit in `systemctl --failed`, not a quiet line in a log.

It never runs `docker compose down`, never passes `--volumes`, and never
recreates a healthy container. A heal is a restart; no data is touched.

```sh
systemctl list-timers signara-self-heal.timer
journalctl -t signara-self-heal -n 40          # what it repaired, if anything
systemctl start signara-self-heal.service      # run it now
bash scripts/self-heal.sh --check              # report only, change nothing
bash scripts/self-heal.sh --verbose            # what every service looked like
```

## Failing loudly

A healer that cannot heal is an incident, so a non-zero exit starts
`signara-self-heal-alert.service` by `OnFailure=`, which posts a
`SignaraSelfHealFailed` alert (severity `critical`) to the stack's Alertmanager at
`127.0.0.1:9093`. That is the same delivery path the estate's other checks use, so
the failure reaches ntfy and whoever is on call instead of sitting in
`systemctl --failed` until someone looks.

```sh
systemctl start signara-self-heal-alert.service     # prove the path
curl -s 127.0.0.1:9093/api/v2/alerts | head           # it is now visible
journalctl -u signara-self-heal-alert -n 20          # a refused POST is a failed unit
```

The alert is not resolved automatically: the next successful heal does not clear
it, because a human should see that it fired at all. Resolve it in Alertmanager
once the cause is understood.

## What it does not cover

- **Bad application code**, wrong credentials, or a failing migration: the healer
  restarts, and a restart cannot fix a bug. Those surface as a container that is
  recreated on every run; the journal names the service each time.
- **A healthcheck that lies.** The healer trusts the healthcheck to define
  "serving". `postgres`'s `pg_isready` and the API's `/ready` are honest, but a
  service with a shallow probe could be recreated forever without improving.
- **The host outside this container.** It runs inside the `signara` container,
  so it cannot fix Incus, the kernel, or a Docker daemon that refuses to start.
  It *can* and does restore the AppArmor profile and the daemon's
  `apparmor-profile` key from the tracked copies, because those are files this
  container owns and the fault that started all of this. What it cannot do is
  diagnose a new one: it repairs known drift, it does not explain novel denial.
  That is precisely why the original signal denial would not have healed itself
  — the diagnosis, not the restart, was the fix.
- **Names that are not files.** A profile renamed in `daemon.json` but deleted
  from `/etc/apparmor.d`, or one loaded from a path other than the tracked one,
  is reported as drift and repaired only in the direction the repository
  describes; the journal names what it changed rather than assuming it was right.
- **Data loss.** It deliberately has no path that deletes a volume, so a corrupt
  database is restored from `infra/backup`, not self-healed.
