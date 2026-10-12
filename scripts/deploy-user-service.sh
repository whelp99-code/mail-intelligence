#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RELEASE_MODE=0
if [[ "${1:-}" == "--release" && "$#" -eq 3 ]]; then
  RELEASE_MODE=1
  RELEASE_SHA="$2"
  RELEASE_DATA_DIR="$3"
  [[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ && "$(basename "$ROOT")" == "$RELEASE_SHA" && -f "$ROOT/VERSION.json" ]] || exit 64
elif [[ "$#" -ne 0 || "$ROOT" != "/home/jm/orca/projects/mail-intelligence" ]]; then
  echo "Unexpected project root: $ROOT" >&2
  exit 1
fi

TEST_TMP_DIR="${MAIL_INTELLIGENCE_TEST_TMP_DIR:-$ROOT/data/deploy-test-runtime}"
mkdir -p "$TEST_TMP_DIR"
chmod 0700 "$ROOT/data" "$TEST_TMP_DIR"
export TMPDIR="$TEST_TMP_DIR"

npm ci
if [[ "$RELEASE_MODE" -eq 1 ]]; then
  (
    export HOME="$TEST_TMP_DIR/home"
    export XDG_CONFIG_HOME="$HOME/.config"
    export XDG_DATA_HOME="$HOME/.local/share"
    export MAIL_INTELLIGENCE_DATA_DIR="$TEST_TMP_DIR/verification-data"
    export MAIL_INTELLIGENCE_LEGACY_DATA_DIR="$TEST_TMP_DIR/legacy"
    unset MAIL_INTELLIGENCE_BACKUP_DIR
    mkdir -p "$HOME" "$MAIL_INTELLIGENCE_DATA_DIR" "$MAIL_INTELLIGENCE_LEGACY_DATA_DIR"
    npm run verify:v1.2.2
  )
  exec bash "$ROOT/scripts/activate-user-service.sh" --release "$RELEASE_SHA" "$RELEASE_DATA_DIR"
fi
npm run verify:v1.2.2
exec bash "$ROOT/scripts/activate-user-service.sh"
