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

mkdir -p "$DATA_DIR" "$BACKUP_DIR"
chmod 0700 "$DATA_DIR" "$BACKUP_DIR"

if [[ ! -s "$ACCESS_KEY_FILE" ]]; then
  umask 077
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" > "$ACCESS_KEY_FILE"
fi
chmod 0600 "$ACCESS_KEY_FILE"
ACCESS_KEY="$(cat "$ACCESS_KEY_FILE")"
if [[ ! "$ACCESS_KEY" =~ ^[A-Za-z0-9_-]{40,}$ ]]; then
  echo "Access key failed validation." >&2
  exit 1
fi

ALLOWED_PROXY_HOSTS=""
if [[ -s "$PROXY_ENV" ]]; then
  ALLOWED_PROXY_HOSTS="$(awk -F= '$1 == "MAIL_INTELLIGENCE_PROXY_BIND" { print $2; exit }' "$PROXY_ENV" | tr -d '[:space:]')"
  if [[ -n "$ALLOWED_PROXY_HOSTS" ]]; then
    MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS="$ALLOWED_PROXY_HOSTS" node --input-type=module - <<'NODE'
import { parseTailnetAllowedHosts } from './src/security/tcp-allowlist-proxy.js';
const hosts = parseTailnetAllowedHosts(process.env.MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS || '');
if (hosts.length !== 1) throw new Error('Exactly one persisted tailnet proxy host is required.');
NODE
  fi
fi

umask 077
cat > "$RUNTIME_ENV.tmp" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3010
MAIL_INTELLIGENCE_DATA_DIR=$DATA_DIR
MAIL_INTELLIGENCE_ACCESS_KEY=$ACCESS_KEY
MAIL_INTELLIGENCE_PERSIST_SECRETS=1
MAIL_INTELLIGENCE_ACTIONS_APPROVED=0
MAIL_INTELLIGENCE_ALLOW_SEND=0
MAIL_INTELLIGENCE_ALLOW_MAIL_MUTATIONS=0
MAIL_INTELLIGENCE_ALLOW_DATA_PLANE=0
MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI=0
MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS=$ALLOWED_PROXY_HOSTS
EOF
chmod 0600 "$RUNTIME_ENV.tmp"
mv "$RUNTIME_ENV.tmp" "$RUNTIME_ENV"
chmod 0600 "$RUNTIME_ENV"
unset ACCESS_KEY

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
    printf 'Access username: mailintelligence\n'
    printf 'Access key file: %s\n' "$ACCESS_KEY_FILE"
    exit 0
  fi
  sleep 0.5
done

systemctl --user status "$SERVICE_NAME" --no-pager || true
journalctl --user -u "$SERVICE_NAME" -n 100 --no-pager || true
echo "Mail Intelligence did not become healthy." >&2
exit 1
