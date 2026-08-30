#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$ROOT" != "/home/jm/orca/projects/mail-intelligence" ]]; then
  echo "Unexpected project root: $ROOT" >&2
  exit 1
fi

npm ci
npm run verify:v1.2.0
exec bash "$ROOT/scripts/activate-user-service.sh"
