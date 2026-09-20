#!/bin/sh
# Render the ${...} placeholders in alertmanager.yml, then start Alertmanager.
#
# Alertmanager cannot expand environment variables in its configuration file
# (there is no --config.expand-env in 0.27 or 0.28), and it does not reject
# unexpanded placeholders: `${SMTP_PASS}` is read as a literal password and
# `amtool check-config` still prints SUCCESS. So an unrendered config produces a
# receiver that silently sends nowhere. Substituting here is what makes the
# receiver real.
#
# POSIX sh and sed only — the prom/alertmanager image is busybox-based and has
# neither envsubst nor bash.
set -eu

template=/etc/alertmanager/alertmanager.yml
rendered=/tmp/alertmanager.rendered.yml

warn() { echo "alertmanager-entrypoint: $*" >&2; }

: "${SMTP_HOST:=}"
: "${SMTP_PORT:=587}"
: "${SMTP_USER:=}"
: "${SMTP_PASS:=}"
: "${SMTP_FROM:=}"
: "${ALERT_EMAIL_TO:=}"

if [ -z "$SMTP_HOST" ]; then
  # Falling back to the host's own MTA keeps the config parseable and the UI
  # running, rather than refusing to start and taking the alerts down with it.
  # Nothing is listening at this address from inside the container, so delivery
  # fails visibly in the log instead of pretending to work — and this warning is
  # the signal that the relay still needs configuring.
  warn 'SMTP_HOST is unset: alerts will be evaluated and visible in the UI, but they cannot be delivered.'
  SMTP_HOST=127.0.0.1
  SMTP_PORT=25
fi

if [ -z "$ALERT_EMAIL_TO" ]; then
  warn 'ALERT_EMAIL_TO is unset: falling back to root@localhost.'
  ALERT_EMAIL_TO=root@localhost
fi

if [ -z "$SMTP_FROM" ]; then
  # Only ever used to address mail the receiver cannot send anyway.
  SMTP_FROM=alertmanager@signara.invalid
fi

# Escape the characters sed treats specially in a replacement.
escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

sed \
  -e "s|\${SMTP_HOST}|$(escape "$SMTP_HOST")|g" \
  -e "s|\${SMTP_PORT}|$(escape "$SMTP_PORT")|g" \
  -e "s|\${SMTP_USER}|$(escape "$SMTP_USER")|g" \
  -e "s|\${SMTP_PASS}|$(escape "$SMTP_PASS")|g" \
  -e "s|\${SMTP_FROM}|$(escape "$SMTP_FROM")|g" \
  -e "s|\${ALERT_EMAIL_TO}|$(escape "$ALERT_EMAIL_TO")|g" \
  "$template" > "$rendered"

# A placeholder left unsubstituted means the config is still a lie in exactly
# the way this script exists to prevent, so stop rather than start blind. Comment
# lines are skipped: the template documents this syntax in its own header, and
# matching that would abort a perfectly rendered config.
if grep -nE '^[^#]*\$\{[A-Za-z_][A-Za-z0-9_]*\}' "$rendered" >&2; then
  warn 'unsubstituted placeholder(s) remain in the rendered config' >&2
  exit 1
fi

chmod 600 "$rendered"

exec /bin/alertmanager \
  --config.file="$rendered" \
  --storage.path=/alertmanager \
  "$@"
