#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SOURCE="$ROOT/deploy/systemd/mail-intelligence.service"
DATA_DIR="$ROOT/data"
BACKUP_DIR="$DATA_DIR/backups"
ACCESS_KEY_FILE="$DATA_DIR/.mail-intelligence-access-key"
RUNTIME_ENV="$DATA_DIR/runtime.env"
PROXY_ENV="$DATA_DIR/tailnet-proxy.env"
SERVICE_NAME="mail-intelligence.service"
HEALTH_URL="http://127.0.0.1:3010/api/health"
USER_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$USER_RUNTIME_DIR}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

if [[ "${1:-}" == "--release" && "$#" -eq 3 ]]; then
  DATA_DIR="$3"
  RUNTIME_ENV="$DATA_DIR/runtime.env"
  ACCESS_KEY_FILE="$DATA_DIR/.mail-intelligence-access-key"
  exec /usr/bin/node "$ROOT/scripts/activate-user-release.mjs" "$ROOT" "$DATA_DIR" "$2"
else
  [[ "$#" -eq 0 ]] || exit 64
mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chmod 0700 "$DATA_DIR" "$BACKUP_DIR"

ALLOWED_PROXY_HOSTS=""
if [[ -s "$PROXY_ENV" ]]; then
  ALLOWED_PROXY_HOSTS="$(awk -F= '$1 == "MAIL_INTELLIGENCE_PROXY_BIND" { print $2; exit }' "$PROXY_ENV" | tr -d '[:space:]')"
  PUBLIC_HOSTS="$(awk -F= '$1 == "MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS" { print $2; exit }' "$RUNTIME_ENV" 2>/dev/null | tr ',' '\n' | awk 'NF && $0 !~ /^[0-9.]+$/ { print }' | paste -sd, -)"
  if [[ -n "$PUBLIC_HOSTS" ]]; then
    ALLOWED_PROXY_HOSTS="${ALLOWED_PROXY_HOSTS},${PUBLIC_HOSTS}"
  fi
  if [[ -n "$ALLOWED_PROXY_HOSTS" ]]; then
    MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS="$ALLOWED_PROXY_HOSTS" node --input-type=module - <<'NODE'
import { parseTailnetAllowedHosts } from './src/security/tcp-allowlist-proxy.js';
const hosts = parseTailnetAllowedHosts(process.env.MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS || '');
const addresses = hosts.filter((host) => /^\d+\.\d+\.\d+\.\d+$/.test(host));
if (addresses.length !== 1) throw new Error('Exactly one persisted tailnet proxy host is required.');
NODE
  fi
fi

umask 077
ACCESS_USERNAME="$(node "$ROOT/scripts/write-runtime-access-env.mjs" "$DATA_DIR" "$ALLOWED_PROXY_HOSTS")"
fi

systemd-analyze --user verify "$UNIT_SOURCE"
systemctl --user link --force "$UNIT_SOURCE"
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user reset-failed "$SERVICE_NAME" 2>/dev/null || true
systemctl --user restart "$SERVICE_NAME"

for _ in $(seq 1 60); do
  if curl --silent --show-error --fail --max-time 2 "$HEALTH_URL" >/dev/null; then
    systemctl --user is-enabled "$SERVICE_NAME"
    systemctl --user is-active "$SERVICE_NAME"
    printf 'Health: %s\n' "$HEALTH_URL"
    printf 'Access username: %s\n' "$ACCESS_USERNAME"
    printf 'Access key file: %s\n' "$ACCESS_KEY_FILE"
    exit 0
  fi
  sleep 0.5
done

systemctl --user status "$SERVICE_NAME" --no-pager || true
journalctl --user -u "$SERVICE_NAME" -n 100 --no-pager || true
echo "Mail Intelligence did not become healthy." >&2
exit 1
