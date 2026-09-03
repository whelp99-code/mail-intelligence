#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_ENV="$ROOT/data/runtime.env"
SERVICE_NAME="mail-intelligence.service"
PROVIDER="${1:-openai-codex-oauth}"
USER_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$USER_RUNTIME_DIR}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

case "$PROVIDER" in
  openai-codex-oauth|xai-grok-oauth) ;;
  *) echo "Provider must be openai-codex-oauth or xai-grok-oauth." >&2; exit 2 ;;
esac

if [[ ! -f "$RUNTIME_ENV" ]]; then
  echo "Runtime environment is missing. Deploy the user service first." >&2
  exit 1
fi

node --input-type=module - "$PROVIDER" <<'NODE'
import { oauthCliProviderStatus } from './src/ai/oauth-cli-provider.js';
const provider = process.argv[2];
const status = await oauthCliProviderStatus(provider, { cwd: process.cwd() });
if (!status.installed || !status.authenticated) {
  console.error(JSON.stringify(status, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ provider, installed: true, authenticated: true, authMode: status.authMode }, null, 2));
NODE

python3 - "$RUNTIME_ENV" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
lines = path.read_text().splitlines()
key = 'MAIL_INTELLIGENCE_ALLOW_EXTERNAL_AI'
updated = []
seen = False
for line in lines:
    if line.startswith(f'{key}='):
        updated.append(f'{key}=1')
        seen = True
    else:
        updated.append(line)
if not seen:
    updated.append(f'{key}=1')
tmp = path.with_suffix(path.suffix + '.tmp')
tmp.write_text('\n'.join(updated) + '\n')
tmp.chmod(0o600)
tmp.replace(path)
path.chmod(0o600)
PY

systemctl --user daemon-reload
systemctl --user restart "$SERVICE_NAME"
systemctl --user is-active --quiet "$SERVICE_NAME"
printf 'OAuth external-AI gate enabled. UI provider selection and data-policy consent are still required.\n'
printf 'Mail send/read-state/data-plane mutations remain disabled.\n'
