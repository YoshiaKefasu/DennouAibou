#!/usr/bin/env pwsh
# Stage runtime node_modules for KASOU deploy (closure-based).
#
# Reads the precomputed dependency closure (kasou-nm-closure.json, generated
# by scanning dist/ static+dynamic imports and BFS-walking each package's
# manifest + file-level imports), filters platform-specific packages that
# cannot run on KASOU (linux-x64, no AVX2, no GPU), and copies the result
# into a clean node_modules tree. Pack with System32 tar and extract at
# ~/.local/lib/dennou-aibou/ on KASOU (Node resolves dist/ imports against
# the parent node_modules).
#
# Usage: pwsh scripts/stage-kasou-node-modules.ps1
# Output: dennou-node-modules.tar (repo root)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
Set-Location $ROOT
$NM = Join-Path $ROOT "node_modules"
$STAGE = Join-Path $env:TEMP "kasou-nm-stage"
$TAR = Join-Path $ROOT "dennou-node-modules.tar"
$CLOSURE = Join-Path $ROOT "scripts" "lib" "kasou-nm-closure.json"

if (-not (Test-Path $CLOSURE)) { Write-Host "[FAIL] closure json missing: $CLOSURE"; exit 1 }

$need = Get-Content $CLOSURE -Raw | ConvertFrom-Json

# Platform-specific / heavy optional packages excluded from the KASOU bundle:
# - Windows/Darwin native binaries (KASOU is linux-x64)
# - node-llama-cpp + its per-platform/accelerator builds (GX-217GA: no AVX2,
#   no discrete GPU; local embeddings feature degrades gracefully)
# - opusscript is pure-JS fallback but voice is Linux-binary based anyway;
#   kept (small) — remove from list if discord voice is needed.
$excludePatterns = @(
    "win32", "darwin", "cuda", "vulkan", "arm64", "riscv64", "musl",
    "node-llama-cpp"
)

function Test-Excluded([string]$pkg) {
    foreach ($pat in $excludePatterns) {
        if ($pkg -like "*$pat*") { return $true }
    }
    return $false
}

$targets = @($need | Where-Object { -not (Test-Excluded $_) })
$excluded = @($need | Where-Object { Test-Excluded $_ })
Write-Host ("Closure: {0} packages, staging {1}, excluding {2}" -f $need.Count, $targets.Count, $excluded.Count)

if (Test-Path $STAGE) { Remove-Item $STAGE -Recurse -Force }
New-Item -ItemType Directory -Path (Join-Path $STAGE "node_modules") -Force | Out-Null

$copied = 0
$missing = New-Object System.Collections.Generic.HashSet[string]
foreach ($p in $targets) {
    $src = Join-Path $NM $p
    if (-not (Test-Path $src)) { [void]$missing.Add($p); continue }
    $resolved = (Get-Item $src).Target
    if ($resolved) { $src = $resolved }
    $dst = Join-Path $STAGE "node_modules" $p
    New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null
    Copy-Item $src $dst -Recurse -Force
    $copied++
}
Write-Host ("  Staged {0} packages" -f $copied)
if ($missing.Count -gt 0) {
    Write-Host ("[WARN] {0} closure packages not found locally (may be nested-only): {1}" -f $missing.Count, ($missing -join ", "))
}

# plugin node_modules already live inside dist/extensions/* (discord/telegram)
$pluginNMs = Get-ChildItem (Join-Path $ROOT "dist" "extensions") -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if (Test-Path (Join-Path $_.FullName "node_modules")) { $_.Name }
}
if ($pluginNMs) { Write-Host ("  dist/extensions plugin node_modules present: {0}" -f ($pluginNMs -join ", ")) }

Write-Host "=== Packing tarball (System32 tar) ==="
if (Test-Path $TAR) { Remove-Item $TAR -Force }
Push-Location $STAGE
& "$env:SystemRoot\System32\tar.exe" -cf $TAR node_modules
Pop-Location
$size = "{0:N1} MB" -f ((Get-Item $TAR).Length / 1MB)
Write-Host "  Packed: $TAR ($size)"
Remove-Item $STAGE -Recurse -Force
Write-Host "=== Done ==="
