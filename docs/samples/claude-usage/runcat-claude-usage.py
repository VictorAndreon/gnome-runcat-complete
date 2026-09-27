#!/usr/bin/env python3
"""
RunCat for GNOME — "Claude" card: 5-hour and 7-day usage limits.

Limits are account-wide, and Claude Code only reports them in two places:

- the terminal status line (live, after every turn of a terminal session), which the
  runcat-statusline.py script saves to a hidden file RunCat ignores:
  RUNCAT_OUT_FILE=~/.config/runcat/metrics/.claude-statusline.json
- the usage cache in ~/.claude.json, refreshed when /usage is opened.

The newest one wins; values older than 30 minutes say how old they are. A window that
has reset since shows 0% if Claude wasn't used afterwards, "—" otherwise.

Run it periodically (systemd user timer). Writes ~/.config/runcat/metrics/claude-usage.json
(RUNCAT_OUT_FILE overrides it).
"""

import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME") or HOME / ".config")
METRICS_DIR = CONFIG_DIR / "runcat" / "metrics"
OUT = Path(os.environ.get("RUNCAT_OUT_FILE") or METRICS_DIR / "claude-usage.json")
STATUSLINE = METRICS_DIR / ".claude-statusline.json"
CLAUDE_JSON = HOME / ".claude.json"
PROJECTS = HOME / ".claude" / "projects"

ICON = "claude-spark-symbolic"
STALE_AFTER_S = 30 * 60
WINDOWS = (("five_hour", "5h"), ("seven_day", "Semanal"))


def number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def parse_iso(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".runcat-", suffix=".tmp", dir=str(path.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def age(seconds):
    if seconds < 3600:
        return f"há {seconds / 60:.0f} min"
    if seconds < 86400:
        return f"há {seconds / 3600:.0f} h"
    return f"há {seconds / 86400:.0f} d"


def format_reset(timestamp, now):
    reset = datetime.fromtimestamp(timestamp)
    if reset.date() == datetime.fromtimestamp(now).date():
        return reset.strftime("%H:%M")
    return reset.strftime("%d/%m %H:%M")


def last_activity():
    """Time of the newest Claude response in any transcript (desktop app or terminal)."""
    newest = 0
    files = sorted(PROJECTS.glob("*/*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:3]
    for path in files:
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in reversed(lines):
            if '"assistant"' in line and '"timestamp"' in line:
                try:
                    ts = parse_iso(json.loads(line).get("timestamp"))
                except ValueError:
                    continue
                if ts:
                    newest = max(newest, ts)
                    break
    return newest


def candidates(name, statusline, statusline_ts, claude_json):
    """[(fetched at, percentage, resets at)] from every source."""
    found = []

    window = ((statusline or {}).get("claudeCodeRateLimits") or {}).get(name) or {}
    pct = number(window.get("used_percentage"))
    if pct is not None and statusline_ts:
        found.append((statusline_ts, pct, number(window.get("resets_at"))))

    cache = (claude_json or {}).get("cachedUsageUtilization") or {}
    fetched = number(cache.get("fetchedAtMs"))
    window = (cache.get("utilization") or {}).get(name) or {}
    pct = number(window.get("utilization"))
    if pct is not None and fetched:
        found.append((fetched / 1000, pct, parse_iso(window.get("resets_at"))))

    return found


def limit_row(title, found, activity, now):
    """The card row and the percentage (None when unknown)."""
    if not found:
        return {"title": title, "formattedValue": "— (abra /usage)"}, None

    fetched, pct, reset = max(found)

    if reset and reset <= now:
        if activity > reset:
            # used since the reset: the new value is unknown until a fresh source arrives
            return {"title": title, "formattedValue": "— (reiniciou, abra /usage)"}, None
        pct, fetched, reset = 0, now, None

    text = f"{pct:.0f}%"
    if reset:
        text += f" · reinicia {format_reset(reset, now)}"
    if now - fetched > STALE_AFTER_S:
        text += f" · {age(now - fetched)}"

    row = {"title": title, "formattedValue": text, "normalizedValue": round(min(max(pct / 100, 0), 1), 4)}
    return row, pct


def main():
    now = time.time()
    claude_json = read_json(CLAUDE_JSON)
    statusline = read_json(STATUSLINE)
    statusline_ts = STATUSLINE.stat().st_mtime if statusline else None
    activity = last_activity()

    rows, panel = [], []
    newest_data = 0
    for name, title in WINDOWS:
        found = candidates(name, statusline, statusline_ts, claude_json)
        row, pct = limit_row(title, found, activity, now)
        rows.append(row)
        panel.append(f"{pct:.0f}%" if pct is not None else "—")
        if found:
            newest_data = max(newest_data, max(found)[0])

    snapshot = {
        "title": "Claude",
        "icon": ICON,
        "metricsBarValue": " · ".join(panel),
        "metrics": rows,
        "lastUpdatedDate": datetime.fromtimestamp(newest_data or now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    write_json(OUT, snapshot)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"runcat claude usage: {e}", file=sys.stderr)
        sys.exit(1)
