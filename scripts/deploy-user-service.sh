#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$ROOT" != "/home/jm/orca/projects/mail-intelligence" ]]; then
  echo "Unexpected project root: $ROOT" >&2
  exit 1
fi

TEST_TMP_DIR="${MAIL_INTELLIGENCE_TEST_TMP_DIR:-$ROOT/data/deploy-test-runtime}"
mkdir -p "$TEST_TMP_DIR"
chmod 0700 "$ROOT/data" "$TEST_TMP_DIR"
export TMPDIR="$TEST_TMP_DIR"

npm ci
npm run verify:v1.2.2
exec bash "$ROOT/scripts/activate-user-service.sh"
