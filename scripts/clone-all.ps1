<#
.SYNOPSIS
  Clone (or fast-forward) every sibling service checkout listed in repos.txt.
.DESCRIPTION
  Idempotent: run it to set the workspace up, run it again to update it. An
  existing checkout with local changes is left alone.
.EXAMPLE
  pwsh ./scripts/clone-all.ps1
  pwsh ./scripts/clone-all.ps1 -List
  pwsh ./scripts/clone-all.ps1 -NoUpdate -Https
#>
[CmdletBinding()]
param(
    [switch]$List,
    [switch]$NoUpdate,
    [switch]$Https
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Join-Path $root 'repos.txt'
if (-not (Test-Path $manifest)) { throw "missing manifest: $manifest" }

# gh is the credential helper for github.com; fall back to https if it is absent
# or unauthenticated rather than failing on a private repo halfway through.
$useGh = -not $Https
if ($useGh) {
    try { gh auth status *> $null; if ($LASTEXITCODE -ne 0) { $useGh = $false } }
    catch { $useGh = $false }
    if (-not $useGh) { Write-Host 'note: gh is unavailable or not authenticated - falling back to https.' }
}

function Sync-Repo([string]$Dir, [string]$Repo) {
    $path = Join-Path $root $Dir

    if (-not (Test-Path $path)) {
        if ($List) { Write-Host "clone   $Dir  <- $Repo"; return }
        Write-Host "==> cloning $Repo into $Dir"
        if ($useGh) { gh repo clone $Repo $path } else { git clone "https://github.com/$Repo.git" $path }
        if ($LASTEXITCODE -ne 0) { Write-Warning "!!  $Dir failed to clone" }
        return
    }

    if (-not (Test-Path (Join-Path $path '.git'))) {
        Write-Warning "!!  $Dir exists but is not a git repo - skipping"; return
    }
    if ($NoUpdate) {
        if (-not $List) { Write-Host "==> $Dir already present (-NoUpdate)" }
        return
    }
    if ($List) { Write-Host "update  $Dir"; return }

    # Refuse to touch work in progress. --ff-only means a diverged branch stops
    # here loudly instead of being merged behind the operator's back.
    if (git -C $path status --porcelain) {
        Write-Host "==> $Dir has uncommitted changes - skipping update"; return
    }
    Write-Host "==> updating $Dir"
    git -C $path pull --ff-only
    if ($LASTEXITCODE -ne 0) { Write-Warning "!!  $Dir could not fast-forward - resolve by hand" }
}

foreach ($line in Get-Content $manifest) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $parts = $trimmed -split '\s+', 3
    Sync-Repo $parts[0] $parts[1]
}

if (-not $List) { Write-Host 'done.' }
