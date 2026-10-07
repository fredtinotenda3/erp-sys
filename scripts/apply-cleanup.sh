#!/usr/bin/env bash
# Operis / erp-sys — App Router structure cleanup
#
# Applies the single change this package contains: removes the stale
# src/app/ duplicate. app/api/v1/* is NOT touched by this script — your
# repo's copy is already the correct, final version (see CHANGES.md).
#
# Idempotent: safe to run even if src/app was already removed.
#
# Usage (from the repo root, e.g. erp-sys/):
#   bash scripts/apply-cleanup.sh

set -euo pipefail

if [ ! -f package.json ] || [ ! -d app ]; then
  echo "Run this from the erp-sys repo root (package.json and app/ must exist here)." >&2
  exit 1
fi

if [ -d src/app ]; then
  echo "Removing stale duplicate: src/app/"
  find src/app -type f | sed 's/^/  - /'
  rm -rf src/app
  echo "Done. src/app/ removed."
else
  echo "src/app/ does not exist — nothing to do."
fi

echo
echo "Verify:"
echo "  find . -iname app -not -path './node_modules/*'   # should print only ./app"
echo "  npm run lint && npx tsc --noEmit && npx vitest run"
