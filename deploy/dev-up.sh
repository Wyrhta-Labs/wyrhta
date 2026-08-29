#!/usr/bin/env bash
# Thin wrapper. All logic lives in deploy/dev-up.mjs so that one implementation
# serves bash, PowerShell and WSL alike — see the header comment there.
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dev-up.mjs" "$@"
