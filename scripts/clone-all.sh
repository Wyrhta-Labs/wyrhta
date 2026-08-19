#!/usr/bin/env bash
# Clone (or fast-forward) every sibling service checkout listed in repos.txt.
#
# Idempotent: run it to set the workspace up, run it again to update it. An
# existing checkout with local changes or unpushed commits is left alone.
#
#   ./scripts/clone-all.sh [--list] [--no-update] [--https]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT/repos.txt"
LIST=false
UPDATE=true
USE_GH=true

for arg in "$@"; do
  case "$arg" in
    --list)      LIST=true ;;
    --no-update) UPDATE=false ;;
    --https)     USE_GH=false ;;
    -h|--help)   sed -n '2,8p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)           echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

[ -f "$MANIFEST" ] || { echo "missing manifest: $MANIFEST" >&2; exit 1; }

# gh is the credential helper for github.com; fall back to https if it is absent
# or unauthenticated rather than failing on a private repo halfway through.
if $USE_GH && ! gh auth status >/dev/null 2>&1; then
  echo "note: gh is unavailable or not authenticated - falling back to https."
  USE_GH=false
fi

clone_one() {
  local dir="$1" repo="$2" path="$ROOT/$dir"

  if [ ! -d "$path" ]; then
    $LIST && { echo "clone   $dir  <- $repo"; return; }
    echo "==> cloning $repo into $dir"
    if $USE_GH; then gh repo clone "$repo" "$path"
    else git clone "https://github.com/$repo.git" "$path"; fi
    return
  fi

  if [ ! -d "$path/.git" ]; then
    echo "!!  $dir exists but is not a git repo - skipping"
    return
  fi

  if ! $UPDATE; then
    $LIST || echo "==> $dir already present (--no-update)"
    return
  fi
  $LIST && { echo "update  $dir"; return; }

  # Refuse to touch work in progress. --ff-only means a diverged branch stops
  # here loudly instead of being merged behind the operator's back.
  if [ -n "$(git -C "$path" status --porcelain)" ]; then
    echo "==> $dir has uncommitted changes - skipping update"
    return
  fi
  echo "==> updating $dir"
  git -C "$path" pull --ff-only || echo "!!  $dir could not fast-forward - resolve by hand"
}

while read -r dir repo _rest; do
  case "${dir:-}" in ''|\#*) continue ;; esac
  clone_one "$dir" "$repo"
done < "$MANIFEST"

$LIST || echo "done."
