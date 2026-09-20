#!/usr/bin/env bash
# check-refs.sh — every commit cited in the tracked tree must still resolve.
#
# Docs and comments cite commits as a backticked short SHA (e.g. `5bf05bc`).
# A history rewrite renumbers every SHA, so a citation that was correct when
# it was written becomes a dead reference in the tree without anyone editing
# the line: the reader gets "unknown revision" and no way to tell what was
# meant. This is not hypothetical — it happened when the webhook work was
# force-pushed, and `docs/Deployment.md` sat pointing at a SHA that no longer
# existed.
#
# So: scan the tracked tree for backticked hex tokens that read as commit
# references and fail if any of them does not resolve to a commit here.
#
#   - Tokens are matched as `[0-9a-f]{7,40}` delimited by backticks, and must
#     contain at least one a–f. That keeps all-digit strings (dates, ids,
#     the migration-dir prefixes) from being mistaken for SHAs.
#   - A citation that genuinely must stay unresolved can be listed in
#     scripts/check-refs.allow, one token per line. It should be rare, and
#     the list being non-empty is itself worth questioning.
set -Eeuo pipefail

allow_file="scripts/check-refs.allow"

mapfile -t cited < <(
  git grep -hoE '`[0-9a-f]{7,40}`' -- . 2>/dev/null \
    | sed -E 's/^`//; s/`$//' \
    | grep -E '[a-f]' \
    | sort -u || true
)

bad=0
for sha in "${cited[@]}"; do
  [ -n "$sha" ] || continue
  if [ -f "$allow_file" ] && grep -qxF "$sha" "$allow_file"; then
    printf 'skip %s (allowlisted)\n' "$sha"
    continue
  fi
  if git rev-parse --verify --quiet "${sha}^{commit}" >/dev/null 2>&1; then
    printf 'ok   %s\n' "$sha"
  else
    printf 'error: %s is cited in the tree but does not resolve to a commit\n' "$sha" >&2
    printf '       a history rewrite renumbers SHAs — repoint the citation to the\n' >&2
    printf '       commit that carries the same change now, or drop the SHA.\n' >&2
    bad=1
  fi
done

if [ "$bad" -ne 0 ]; then
  exit 1
fi

printf 'commit citations: all resolve\n'
