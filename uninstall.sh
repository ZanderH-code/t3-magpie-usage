#!/usr/bin/env bash
set -euo pipefail

PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]] || ! command -v systemctl >/dev/null; then
  echo "Uninstaller requires Python 3 and systemd." >&2
  exit 1
fi
if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
  echo "Run this from the same Linux user session that installed the service." >&2
  exit 1
fi

T3_SETTINGS="${T3_SETTINGS:-${HOME}/.t3/userdata/settings.json}"
INSTALL_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/t3-magpie-usage"
CONFIG_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/t3-magpie-usage"
SERVICE_FILE="${HOME}/.config/systemd/user/t3-magpie-usage.service"
ENV_FILE="${CONFIG_DIR}/config.env"
PORT="${PORT:-}"
if [[ -z "$PORT" && -f "$ENV_FILE" ]]; then
  PORT="$(awk -F= '$1 == "PORT" {print $2; exit}' "$ENV_FILE")"
fi
PORT="${PORT:-38765}"

systemctl --user disable --now t3-magpie-usage.service 2>/dev/null || true
rm -f "$SERVICE_FILE"
systemctl --user daemon-reload

if [[ -f "$T3_SETTINGS" ]]; then
  T3_SETTINGS="$T3_SETTINGS" PORT="$PORT" "$PYTHON_BIN" -I - <<'PY'
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

path = Path(os.environ["T3_SETTINGS"]).expanduser()
data = json.loads(path.read_text(encoding="utf-8"))
sources = data.get("usageLimitSources", {})
expected = {"magpieRelay": f"http://127.0.0.1:{os.environ['PORT']}"}
removed = []
for source_id, url in expected.items():
    entry = sources.get(source_id)
    if entry and entry.get("url") == url:
        del sources[source_id]
        removed.append(source_id)
if removed:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(f"{path.name}.before-magpie-uninstall-{stamp}")
    shutil.copy2(path, backup)
    if not sources:
        data.pop("usageLimitSources", None)
    tmp = path.with_name(path.name + ".magpie-tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(tmp, path.stat().st_mode & 0o777)
    tmp.replace(path)
    print("Removed T3 source entries:", ", ".join(removed))
else:
    print("No matching T3 source entries found; settings were left unchanged.")
PY
fi

rm -rf -- "$INSTALL_DIR" "$CONFIG_DIR"
printf 'Uninstalled the Magpie bridge. Magpie account data was not changed.\n'
