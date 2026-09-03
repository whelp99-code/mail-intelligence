#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERIFY_ROOT="$ROOT/data/working-copy-verification"
mkdir -p "$VERIFY_ROOT"
chmod 0700 "$VERIFY_ROOT"
VERIFY_DIR="$(mktemp -d "$VERIFY_ROOT/run-XXXXXX")"
chmod 0700 "$VERIFY_DIR"
cleanup() {
  rm -rf "$VERIFY_DIR"
}
trap cleanup EXIT

cd "$ROOT"
tar \
  --exclude='./.git' \
  --exclude='./.chatgpt2codex' \
  --exclude='./node_modules' \
  --exclude='./data' \
  --exclude='./backups' \
  --exclude='./artifacts' \
  --exclude='./.env' \
  --exclude='./.env.*' \
  --exclude='./.outlook-config.json' \
  --exclude='./.mail-cache.json' \
  -cf - . | tar -xf - -C "$VERIFY_DIR"

cd "$VERIFY_DIR"
npm ci --ignore-scripts --no-fund --no-audit
npm run verify:v1.2.2
printf 'working-copy-snapshot=PASS source=%s\n' "$ROOT"
