#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_DIR="$(mktemp -d /tmp/mail-intelligence-fresh-extract-XXXXXX)"
cleanup() {
  rm -rf "$VERIFY_DIR"
}
trap cleanup EXIT

cd "$ROOT"
git diff --quiet || {
  echo "Fresh-extract verification requires committed source changes." >&2
  exit 1
}
git diff --cached --quiet || {
  echo "Fresh-extract verification requires an empty index." >&2
  exit 1
}

git archive HEAD | tar -x -C "$VERIFY_DIR"
cd "$VERIFY_DIR"
npm ci --ignore-scripts --no-fund
npm run verify:v1.2.0
printf 'fresh-extract=PASS commit=%s\n' "$(git --git-dir="$ROOT/.git" rev-parse HEAD)"
