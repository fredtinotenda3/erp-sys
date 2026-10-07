# Operis / erp-sys — App Router structure cleanup
#
# Applies the single change this package contains: removes the stale
# src/app/ duplicate. app/api/v1/* is NOT touched by this script — your
# repo's copy is already the correct, final version (see CHANGES.md).
#
# Idempotent: safe to run even if src/app was already removed.
#
# Usage (from the repo root, e.g. erp-sys\), in PowerShell:
#   .\scripts\apply-cleanup.ps1

$ErrorActionPreference = "Stop"

if (-not (Test-Path "package.json") -or -not (Test-Path "app")) {
    Write-Error "Run this from the erp-sys repo root (package.json and app\ must exist here)."
    exit 1
}

if (Test-Path "src\app") {
    Write-Host "Removing stale duplicate: src\app\"
    Get-ChildItem -Path "src\app" -Recurse -File | ForEach-Object {
        Write-Host "  - $($_.FullName)"
    }
    Remove-Item -Path "src\app" -Recurse -Force
    Write-Host "Done. src\app\ removed."
} else {
    Write-Host "src\app\ does not exist - nothing to do."
}

Write-Host ""
Write-Host "Verify:"
Write-Host "  Get-ChildItem -Recurse -Directory -Filter app | Where-Object { `$_.FullName -notmatch 'node_modules' }"
Write-Host "  npm run lint; npx tsc --noEmit; npx vitest run"
