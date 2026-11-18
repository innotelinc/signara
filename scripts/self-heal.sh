#!/usr/bin/env bash
# self-heal.sh — repair the states Docker cannot see, for the Signara stack.
#
# Why this exists
# ---------------
# `restart: unless-stopped` reacts to a process that **exits**. It cannot react
# to a container that stays `running` and stops serving. Between 2026-11-15 and
# 2026-11-18 the postgres container sat `running (unhealthy)` with empty logs:
# AppArmor denied the container the right to signal its own processes
# (docs/self-healing.md), so the image's `gosu` privilege drop retried forever at
# ~100% CPU and never exec'd postgres. Docker counted that as a live container,
# so nothing restarted it, and `signara-api` crash-looped behind it with
# `PrismaClientInitializationError P1001` for two days. The healthcheck reported
# the truth the whole time; nothing acted on it.
#
# What this does
# --------------
# Walks the services in dependency order and repairs only what is provably not
# serving:
#
#   container missing / exited / dead  -> `up -d --no-deps <service>`
#   running but unhealthy for N        -> `up -d --force-recreate --no-deps`
#   consecutive healthchecks
#   one-shot that exited non-zero      -> `up -d --no-deps migrate`
#
# A container whose healthcheck is still `starting` is left alone, so a slow
# boot is not punished. Afterwards it asserts the stack answers: postgres via
# `pg_isready`, the API via `/ready`.
#
# What it never does
# ------------------
# No `docker compose down`, no `--volumes`, no volume or image removal, and no
# recreate of a container that is healthy. A heal is a restart, not a rebuild:
# data is never touched.
#
# Usage
#   self-heal.sh             repair, then verify — what the timer runs
#   self-heal.sh --check     report only, change nothing; exit 1 if not serving
#   self-heal.sh --verbose   log every service, not just the repaired ones
#
# Exit: 0 the stack is serving; 1 something is still broken. Never a silent pass.

set -uo pipefail

COMPOSE_DIR=${SIGNARA_DIR:-/usr/src/projects/complete/1-primary/signara}
COMPOSE_FILE=$COMPOSE_DIR/docker-compose.prod.yml
PROJECT=signara

# Dependencies first; `migrate` is a one-shot and gets its own rule below.
SERVICES="postgres redis meilisearch migrate api frontend alertmanager prometheus backup backup-metrics dns-probe"

# Consecutive failed healthchecks before a container is treated as hung. The
# postgres check runs every 5s and the API every 15s, so this is 15-45s of
# proven failure — a single late probe is not enough to recreate anything.
FAIL_THRESHOLD=${FAIL_THRESHOLD:-3}

MODE=repair
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --verbose | -v) VERBOSE=1 ;;
    -h | --help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

log() {
  logger -t signara-self-heal -- "$*" 2>/dev/null || true
  printf '%s\n' "$*"
}

fail() {
  log "FAILED: $*"
  exit 1
}

[ -f "$COMPOSE_FILE" ] || fail "no compose definition at $COMPOSE_FILE"
command -v docker >/dev/null 2>&1 || fail "docker is not on PATH"

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
cname() { printf '%s-%s-1' "$PROJECT" "$1"; }

field() { docker inspect -f "$2" "$1" 2>/dev/null; }
status_of() { field "$1" '{{.State.Status}}'; }
health_of() { field "$1" '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'; }
fails_of() { field "$1" '{{if .State.Health}}{{.State.Health.FailingStreak}}{{else}}0{{end}}'; }

# `compose config --services` is the definition itself, so a service that was
# renamed or dropped is skipped rather than reported as missing.
DEFINED=$(compose config --services 2>/dev/null)

defined() { printf '%s\n' "$DEFINED" | grep -qx "$1"; }

repair() {
  local svc=$1 c st h f procs rc
  defined "$svc" || return 0
  c=$(cname "$svc")
  st=$(status_of "$c")

  if [ -z "$st" ]; then
    log "$svc: container missing; creating"
    [ "$MODE" = check ] && return 1
    compose up -d --no-deps "$svc" >/dev/null 2>&1 || {
      log "$svc: creation failed"
      return 1
    }
    return 0
  fi

  if [ "$svc" = migrate ]; then
    case "$st" in
      exited)
        rc=$(field "$c" '{{.State.ExitCode}}')
        if [ "${rc:-0}" -ne 0 ]; then
          log "migrate: last run exited $rc; re-running"
          [ "$MODE" = check ] && return 1
          compose up -d --no-deps migrate >/dev/null 2>&1 || {
            log "migrate: re-run failed to start"
            return 1
          }
        else
          [ "$VERBOSE" = 1 ] && log "migrate: ok (exited 0)"
        fi
        ;;
      running) [ "$VERBOSE" = 1 ] && log "migrate: running" ;;
      *) [ "$VERBOSE" = 1 ] && log "migrate: $st" ;;
    esac
    return 0
  fi

  if [ "$st" != running ]; then
    log "$svc: $st; starting"
    [ "$MODE" = check ] && return 1
    compose up -d --no-deps "$svc" >/dev/null 2>&1 || {
      log "$svc: start failed"
      return 1
    }
    return 0
  fi

  h=$(health_of "$c")
  f=$(fails_of "$c")
  if [ "$h" = unhealthy ] && [ "${f:-0}" -ge "$FAIL_THRESHOLD" ]; then
    # This is the hang signature, and the reason this script exists: the
    # container is up, so no restart policy fires, but its process tree holds
    # no real work. Recording the pids makes that visible in the journal.
    procs=$(docker top "$c" -eo comm 2>/dev/null | awk 'NR>1' | tr '\n' ' ')
    log "$svc: unhealthy for $f checks, processes: ${procs:-none}; recreating"
    [ "$MODE" = check ] && return 1
    compose up -d --force-recreate --no-deps "$svc" >/dev/null 2>&1 || {
      log "$svc: recreate failed"
      return 1
    }
    return 0
  fi

  [ "$VERBOSE" = 1 ] && log "$svc: $st/${h}"
  return 0
}

broken=0
for svc in $SERVICES; do
  repair "$svc" || broken=1
done

# Readiness is asserted, not inferred from health status: the API can be
# `starting` while postgres is already up, and a healthy container says nothing
# about whether the database behind it answers.
pg_user() {
  field "$(cname postgres)" '{{range .Config.Env}}{{println .}}{{end}}' |
    sed -n 's/^POSTGRES_USER=//p' | head -1
}

wait_for() {
  local label=$1 tries=$2
  shift 2
  local i
  for i in $(seq 1 "$tries"); do
    if "$@" >/dev/null 2>&1; then
      [ "$VERBOSE" = 1 ] && log "$label: ready after ${i} probe(s)"
      return 0
    fi
    sleep 3
  done
  log "$label: not ready after $((tries * 3))s"
  return 1
}

pg_probe() { docker exec "$(cname postgres)" pg_isready -q -U "$(pg_user || echo signara)" >/dev/null 2>&1; }
api_probe() { docker exec "$(cname api)" wget -qO- http://127.0.0.1:8000/ready >/dev/null 2>&1; }

if [ "$broken" -eq 1 ] && [ "$MODE" = repair ]; then
  # The repairs above are asynchronous; give them the same patience the
  # healthchecks have before declaring failure.
  log "waiting for the repaired stack"
fi

wait_for postgres 20 pg_probe || broken=1
wait_for api 20 api_probe || broken=1

if [ "$broken" -eq 1 ]; then
  log "NOT SERVING: postgres=$(health_of "$(cname postgres)") api=$(health_of "$(cname api)")"
  exit 1
fi

# A heal that changed nothing still gets one line, so the journal proves the
# timer is running rather than leaving a silent unit to be trusted on faith.
log "ok: postgres, api and frontend serving"
exit 0
