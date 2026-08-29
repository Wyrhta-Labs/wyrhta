# Thin wrapper. All logic lives in deploy/dev-up.mjs so that one implementation
# serves bash, PowerShell and WSL alike — see the header comment there.
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'dev-up.mjs') @args
exit $LASTEXITCODE
