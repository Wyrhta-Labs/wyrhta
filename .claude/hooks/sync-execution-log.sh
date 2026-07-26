#!/usr/bin/env bash
# Keep docs/execution-log.md in step with the execution tooling's live ledger.
#
# Source: .superpowers/sdd/progress.md (git-ignored, rewritten by the subagent-driven
# execution skill as work progresses). Target: docs/execution-log.md (committed).
#
# The target's hand-written preamble — everything above its first "## " heading — is
# preserved; only the phase sections below it are replaced. Runs on Stop; a no-op when
# nothing changed, so it produces no diff churn on ordinary turns.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
src="$root/.superpowers/sdd/progress.md"
dst="$root/docs/execution-log.md"

# Nothing to sync from, or a source with no phase sections yet: leave the log alone.
[ -f "$src" ] || exit 0
grep -qE '^## ' "$src" || exit 0

tmp="$(mktemp)" || exit 0
trap 'rm -f "$tmp"' EXIT

# Preamble: the target's own, so edits to it survive. Fall back to the source's.
if [ -f "$dst" ] && grep -qE '^## ' "$dst"; then
  sed -n '1,/^## /p' "$dst" | sed '$d' > "$tmp"
else
  sed -n '1,/^## /p' "$src" | sed '$d' > "$tmp"
fi

# Body: every phase section from the live ledger.
sed -n '/^## /,$p' "$src" >> "$tmp"

# --strip-trailing-cr so a CRLF checkout of the target isn't rewritten on every turn.
if ! diff -q --strip-trailing-cr "$tmp" "$dst" >/dev/null 2>&1; then
  cp "$tmp" "$dst" && printf '{"systemMessage":"Synced docs/execution-log.md from the execution ledger — review and commit it."}\n'
fi
