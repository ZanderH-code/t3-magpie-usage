#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="$(command -v node || true)"
PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$NODE_BIN" || -z "$PYTHON_BIN" ]]; then
  echo "This installer requires Node.js 20+ and Python 3." >&2
  exit 1
fi
if ! "$NODE_BIN" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
  echo "Node.js 20 or later is required." >&2
  exit 1
fi
if ! command -v curl >/dev/null; then
  echo "This installer requires curl." >&2
  exit 1
fi
if ! command -v systemctl >/dev/null || [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  echo "This installer currently supports Linux with a running systemd user session." >&2
  exit 1
fi

MAGPIE_URL="${MAGPIE_URL:-http://127.0.0.1:3425}"
T3_SETTINGS="${T3_SETTINGS:-${HOME}/.t3/userdata/settings.json}"
INSTALL_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/t3-magpie-usage"
CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/t3-magpie-usage"
SERVICE_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SERVICE_DIR}/t3-magpie-usage.service"
ENV_FILE="${CONFIG_DIR}/config.env"
PORT="${PORT:-38765}"
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65535 )); then
  echo "PORT must be an integer from 1024 to 65535." >&2
  exit 1
fi

if [[ ! -f "$T3_SETTINGS" ]]; then
  echo "T3 settings not found at $T3_SETTINGS. Start T3 Code once, or set T3_SETTINGS." >&2
  exit 1
fi

MAGPIE_URL="${MAGPIE_URL%/}"
if [[ "$MAGPIE_URL" == *$'\n'* || "$MAGPIE_URL" == *$'\r'* ]] || ! "$NODE_BIN" --input-type=module -e 'try { const u = new URL(process.argv[1]); process.exit(u.protocol === "http:" || u.protocol === "https:" ? 0 : 1); } catch { process.exit(1); }' "$MAGPIE_URL"; then
  echo "MAGPIE_URL must be a valid http(s) URL without line breaks." >&2
  exit 1
fi
if ! "$PYTHON_BIN" -I - "$T3_SETTINGS" "$PORT" <<'PY'
import json
import sys
from pathlib import Path
path = Path(sys.argv[1]).expanduser()
data = json.loads(path.read_text(encoding="utf-8"))
sources = data.get("usageLimitSources", {})
port = sys.argv[2]
expected = {"magpieRelay": f"http://127.0.0.1:{port}"}
for source_id, url in expected.items():
    current = sources.get(source_id)
    if current and current.get("url") != url:
        raise SystemExit(f"Refusing to replace existing T3 source '{source_id}' ({current.get('url')}). Rename or remove that entry first.")
PY
then
  exit 1
fi
if ! curl --fail --silent --show-error --max-time 8 -H 'Authorization: Bearer local' "${MAGPIE_URL}/v1/magpie/accounts" >/dev/null; then
  echo "Cannot reach Magpie accounts API at ${MAGPIE_URL}/v1/magpie/accounts." >&2
  exit 1
fi
if ! curl --fail --silent --show-error --max-time 8 -H 'Authorization: Bearer local' "${MAGPIE_URL}/v1/magpie/quotas" >/dev/null; then
  echo "Cannot reach Magpie quotas API at ${MAGPIE_URL}/v1/magpie/quotas." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$SERVICE_DIR"
chmod 700 "$CONFIG_DIR"
cp "$SCRIPT_DIR/server.mjs" "$INSTALL_DIR/server.mjs.new"
chmod 755 "$INSTALL_DIR/server.mjs.new"
mv "$INSTALL_DIR/server.mjs.new" "$INSTALL_DIR/server.mjs"

if [[ -f "$ENV_FILE" ]]; then
  MANAGEMENT_KEY="$(awk -F= '$1 == "MANAGEMENT_KEY" {print substr($0, index($0, "=") + 1); exit}' "$ENV_FILE")"
else
  MANAGEMENT_KEY=""
fi
if [[ ! "$MANAGEMENT_KEY" =~ ^[0-9a-f]{64}$ ]]; then
  MANAGEMENT_KEY="$("$NODE_BIN" --input-type=module -e 'import {randomBytes} from "node:crypto"; console.log(randomBytes(32).toString("hex"))')"
fi
umask 077
printf 'MAGPIE_URL=%s\nPORT=%s\nMANAGEMENT_KEY=%s\n' "$MAGPIE_URL" "$PORT" "$MANAGEMENT_KEY" > "$ENV_FILE"
chmod 600 "$ENV_FILE"

T3_SETTINGS="$T3_SETTINGS" MANAGEMENT_KEY="$MANAGEMENT_KEY" PORT="$PORT" "$PYTHON_BIN" -I - <<'PY'
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

path = Path(os.environ["T3_SETTINGS"]).expanduser()
data = json.loads(path.read_text(encoding="utf-8"))
sources = data.setdefault("usageLimitSources", {})
for source_id, label, suffix in (
    ("magpieRelay", "Magpie", ""),
):
    current = sources.get(source_id)
    url = f"http://127.0.0.1:{os.environ['PORT']}{suffix}"
    if current and current.get("url") != url:
        raise SystemExit(f"Refusing to replace existing T3 source '{source_id}' ({current.get('url')}). Rename or remove that entry first.")
    sources[source_id] = {
        "kind": "cliproxy",
        "label": label,
        "url": url,
        "managementKey": os.environ["MANAGEMENT_KEY"],
        "enabled": True,
    }
stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
backup = path.with_name(f"{path.name}.before-magpie-install-{stamp}")
shutil.copy2(path, backup)
tmp = path.with_name(path.name + ".magpie-tmp")
tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
os.chmod(tmp, path.stat().st_mode & 0o777)
tmp.replace(path)
PY

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Magpie quota bridge for T3 Code
After=network.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $INSTALL_DIR/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadOnlyPaths=$INSTALL_DIR

[Install]
WantedBy=default.target
EOF
chmod 600 "$SERVICE_FILE"
systemctl --user daemon-reload
systemctl --user enable t3-magpie-usage.service
systemctl --user restart t3-magpie-usage.service

for attempt in {1..20}; do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null; then
    break
  fi
  sleep 0.25
done
if ! curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${PORT}/health"; then
  echo "Service did not become healthy; inspect: journalctl --user -u t3-magpie-usage.service" >&2
  exit 1
fi
printf '\nInstalled. Refresh T3 Code usage limits to load the Magpie accounts.\n'
printf 'Config: %s\nSettings: %s\n' "$ENV_FILE" "$T3_SETTINGS"
