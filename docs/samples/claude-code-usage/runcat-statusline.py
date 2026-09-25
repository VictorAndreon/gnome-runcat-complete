#!/usr/bin/env python3
"""
RunCat for GNOME — Claude Code usage card.

Claude Code runs its status line command after every turn and passes the session data
as JSON on stdin (https://code.claude.com/docs/en/statusline). This script turns it into
a RunCat custom metrics card with the model, context window, 5-hour and 7-day rate
limits and the session cost, then prints a status line for the terminal.

Already have a status line? Pass its command as arguments (or in RUNCAT_WRAP_COMMAND):
it receives the same stdin and its output is printed instead of the default one.

    "command": "~/.claude/runcat-statusline.py ~/.claude/my-statusline.sh"

Rate limits are account-wide, so the last known 5-hour and 7-day values are kept (until
they reset) when a session that hasn't made an API request yet updates the card.

RUNCAT_OUT_FILE overrides the output file
(default: ~/.config/runcat/metrics/claude-code.json).
"""

import json
import os
import shlex
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
OUT = Path(os.environ.get("RUNCAT_OUT_FILE") or CONFIG_DIR / "runcat" / "metrics" / "claude-code.json")


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def format_reset(epoch_seconds):
    try:
        reset = datetime.fromtimestamp(epoch_seconds)
    except (TypeError, ValueError, OSError, OverflowError):
        return None
    if reset.date() == datetime.now().date():
        return reset.strftime("%H:%M")
    return reset.strftime("%d/%m %H:%M")


def percent_row(title, percentage, resets_at=None):
    percentage = number(percentage)
    if percentage is None:
        return None
    reset = format_reset(resets_at) if resets_at else None
    text = f"{percentage:.0f}%" + (f" (resets {reset})" if reset else "")
    return {"title": title, "formattedValue": text, "normalizedValue": round(min(max(percentage / 100, 0), 1), 4)}


def write_atomically(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".runcat-", suffix=".tmp", dir=str(path.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


raw = sys.stdin.read()

try:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        payload = {}
except ValueError:
    payload = {}

def load_previous_limits():
    try:
        previous = json.loads(OUT.read_text(encoding="utf-8")).get("claudeCodeRateLimits") or {}
    except (OSError, ValueError, AttributeError):
        return {}
    now = datetime.now().timestamp()
    return {
        name: window for name, window in previous.items()
        if isinstance(window, dict) and number(window.get("resets_at")) and window["resets_at"] > now
    }


model = (payload.get("model") or {}).get("display_name") or "Claude Code"
context = number((payload.get("context_window") or {}).get("used_percentage"))
cost = number((payload.get("cost") or {}).get("total_cost_usd"))
limits = {**load_previous_limits(), **(payload.get("rate_limits") or {})}
five_hour = limits.get("five_hour") or {}
seven_day = limits.get("seven_day") or {}

rows = [
    {"title": "Model", "formattedValue": model},
    percent_row("Context", context),
    percent_row("5h limit", five_hour.get("used_percentage"), five_hour.get("resets_at")),
    percent_row("7d limit", seven_day.get("used_percentage"), seven_day.get("resets_at")),
    {"title": "Session cost", "formattedValue": f"${cost:.2f}"} if cost is not None else None,
]

snapshot = {
    "title": "Claude Code",
    "icon": "sparkle",
    "metrics": [row for row in rows if row is not None],
    "lastUpdatedDate": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    # not displayed, remembered for the next sessions
    "claudeCodeRateLimits": {name: limits[name] for name in ("five_hour", "seven_day") if name in limits},
}

# the top bar shows the 5-hour limit when available (Pro/Max plans), the context otherwise
panel = number(five_hour.get("used_percentage"))
panel = panel if panel is not None else context
if panel is not None:
    snapshot["metricsBarValue"] = f"{panel:.0f}%"

try:
    # an empty payload (e.g. running the script by hand) must not replace real data
    if payload:
        write_atomically(OUT, snapshot)
except OSError as e:
    print(f"runcat: {e}", file=sys.stderr)

wrapped = sys.argv[1:] or shlex.split(os.environ.get("RUNCAT_WRAP_COMMAND", ""))

if wrapped:
    command = [os.path.expanduser(part) for part in wrapped]
    try:
        result = subprocess.run(command, input=raw, capture_output=True, text=True, timeout=10)
        sys.stdout.write(result.stdout)
    except (OSError, subprocess.SubprocessError) as e:
        print(f"runcat: failed to run {command[0]}: {e}")
else:
    print(model + (f" · {context:.0f}% context" if context is not None else ""))
