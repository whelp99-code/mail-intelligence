#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SOURCE="$ROOT/deploy/systemd/mail-intelligence-tailnet.service"
DATA_DIR="$ROOT/data"
PROXY_ENV="$DATA_DIR/tailnet-proxy.env"
RUNTIME_ENV="$DATA_DIR/runtime.env"
SERVICE_NAME="mail-intelligence-tailnet.service"
APP_SERVICE_NAME="mail-intelligence.service"
USER_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$USER_RUNTIME_DIR}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "Tailscale CLI is required for tailnet-only exposure." >&2
  exit 1
fi

TAILNET_IP="$(tailscale ip -4 2>/dev/null | head -n 1 | tr -d '[:space:]')"
if [[ -z "$TAILNET_IP" ]]; then
  TAILNET_IP="$(ip -o -4 address show dev tailscale0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n 1)"
fi
if [[ -z "$TAILNET_IP" ]]; then
  echo "No active Tailscale IPv4 address was found." >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
chmod 0700 "$DATA_DIR"
if [[ ! -s "$RUNTIME_ENV" ]]; then
  echo "Main runtime environment is missing. Run scripts/deploy-user-service.sh first." >&2
  exit 1
fi
umask 077
cat > "$PROXY_ENV.tmp" <<EOF
MAIL_INTELLIGENCE_PROXY_BIND=$TAILNET_IP
MAIL_INTELLIGENCE_PROXY_PORT=3010
MAIL_INTELLIGENCE_PROXY_TARGET_HOST=127.0.0.1
MAIL_INTELLIGENCE_PROXY_TARGET_PORT=3010
MAIL_INTELLIGENCE_PROXY_ALLOWED_CIDRS=100.64.0.0/10
MAIL_INTELLIGENCE_PROXY_MAX_CONNECTIONS=128
MAIL_INTELLIGENCE_PROXY_IDLE_TIMEOUT_MS=300000
EOF
chmod 0600 "$PROXY_ENV.tmp"
mv "$PROXY_ENV.tmp" "$PROXY_ENV"
chmod 0600 "$PROXY_ENV"

set -a
# shellcheck disable=SC1090
source "$PROXY_ENV"
set +a
node --input-type=module - <<'NODE'
import { loadProxyConfig } from './src/security/tcp-allowlist-proxy.js';
const config = loadProxyConfig(process.env);
if (!config.bindHost.startsWith('100.')) throw new Error('Tailnet proxy must bind to the Tailscale IPv4 address.');
NODE

grep -v '^MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS=' "$RUNTIME_ENV" > "$RUNTIME_ENV.tmp"
printf 'MAIL_INTELLIGENCE_ALLOWED_PROXY_HOSTS=%s\n' "$TAILNET_IP" >> "$RUNTIME_ENV.tmp"
chmod 0600 "$RUNTIME_ENV.tmp"
mv "$RUNTIME_ENV.tmp" "$RUNTIME_ENV"
chmod 0600 "$RUNTIME_ENV"

systemctl --user restart "$APP_SERVICE_NAME"
APP_HEALTHY=0
for _ in $(seq 1 60); do
  if curl --silent --show-error --fail --max-time 2 http://127.0.0.1:3010/api/health >/dev/null; then
    APP_HEALTHY=1
    break
  fi
  sleep 0.5
done
systemctl --user is-active "$APP_SERVICE_NAME" >/dev/null
if [[ "$APP_HEALTHY" != "1" ]]; then
  echo "Main Mail Intelligence service did not become healthy after proxy-host activation." >&2
  exit 1
fi

systemd-analyze --user verify "$UNIT_SOURCE"
systemctl --user link --force "$UNIT_SOURCE"
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME"
systemctl --user reset-failed "$SERVICE_NAME" 2>/dev/null || true
systemctl --user restart "$SERVICE_NAME"

HEALTH_URL="http://$TAILNET_IP:3010/api/health"
for _ in $(seq 1 60); do
  if curl --silent --show-error --fail --max-time 2 "$HEALTH_URL" >/dev/null; then
    systemctl --user is-enabled "$SERVICE_NAME"
    systemctl --user is-active "$SERVICE_NAME"
    ss -ltn | grep -F "$TAILNET_IP:3010" >/dev/null
    ss -ltn | grep -F "127.0.0.1:3010" >/dev/null
    printf 'Tailnet URL: http://%s:3010\n' "$TAILNET_IP"
    printf 'Backend remains loopback-only: http://127.0.0.1:3010\n'
    printf 'Allowed source range: 100.64.0.0/10\n'
    exit 0
  fi
  sleep 0.5
done

systemctl --user status "$SERVICE_NAME" --no-pager || true
journalctl --user -u "$SERVICE_NAME" -n 100 --no-pager || true
echo "Mail Intelligence tailnet proxy did not become healthy." >&2
exit 1
