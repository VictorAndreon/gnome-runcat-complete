#!/usr/bin/env python3
"""
RunCat for GNOME — Claude Code sessions card, driven by Claude Code hooks.

Shows what every running Claude Code session is doing: working, waiting for you
(permission prompt or idle prompt) or done, per project. Register this script for the
SessionStart, UserPromptSubmit, PreToolUse, Notification, Stop and SessionEnd hooks
(see README.md). Hooks pass the event as JSON on stdin
(https://code.claude.com/docs/en/hooks).

The script never prints anything (stdout of some hooks is added to Claude's context)
and always exits 0 so it can't interrupt Claude Code.

RUNCAT_OUT_FILE overrides the output file
(default: ~/.config/runcat/metrics/claude-code-sessions.json).
"""

import fcntl
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
OUT = Path(os.environ.get("RUNCAT_OUT_FILE") or CONFIG_DIR / "runcat" / "metrics" / "claude-code-sessions.json")

# sessions without events for this long are considered gone (crashed, killed terminal, …)
STALE_AFTER_S = 12 * 3600

WORKING, WAITING, DONE = "working", "waiting", "done"

STATUS_TEXT = {WORKING: "Working", WAITING: "Waiting for you", DONE: "Done"}


def format_since(timestamp):
    return datetime.fromtimestamp(timestamp).strftime("since %H:%M")


def build_card(sessions):
    ordered = sorted(sessions.values(), key=lambda s: s["since"], reverse=True)

    rows = []
    for session in ordered:
        text = f"{STATUS_TEXT[session['status']]} {format_since(session['since'])}"
        if session.get("detail"):
            text += f" · {session['detail']}"
        rows.append({"title": session["project"], "formattedValue": text})

    waiting = sum(1 for s in ordered if s["status"] == WAITING)
    working = sum(1 for s in ordered if s["status"] == WORKING)

    if waiting:
        panel = f"⚠ {waiting}"
    elif working:
        panel = f"⋯ {working}"
    else:
        panel = "✓"

    if not rows:
        rows.append({"title": "Sessions", "formattedValue": "none running"})

    return {
        "title": "Claude Code sessions",
        "icon": "sparkle",
        "metricsBarValue": panel,
        "metrics": rows,
        "lastUpdatedDate": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        # not displayed: the state the next hook invocation starts from
        "claudeCodeSessions": sessions,
    }


def apply_event(sessions, event, now):
    session_id = event.get("session_id")
    name = event.get("hook_event_name")

    if not session_id or not name:
        return

    # subagents share the session id of their parent: ignore their events
    if event.get("agent_id"):
        return

    if name == "SessionEnd":
        sessions.pop(session_id, None)
        return

    project = os.path.basename((event.get("cwd") or "").rstrip("/")) or "Claude Code"
    session = sessions.setdefault(session_id, {"project": project, "status": DONE, "since": now, "detail": None})
    session["project"] = project
    session["seen"] = now

    status, detail = session["status"], session.get("detail")

    if name == "SessionStart":
        status, detail = DONE, None
    elif name == "UserPromptSubmit":
        status, detail = WORKING, None
    elif name == "PreToolUse":
        status, detail = WORKING, event.get("tool_name")
    elif name == "Notification":
        kind = event.get("notification_type") or ""
        if kind in ("auth_success", "agent_completed") or kind.startswith("quota_"):
            return
        status, detail = WAITING, (event.get("message") or "")[:60] or None
    elif name == "Stop":
        status, detail = DONE, None
    else:
        return

    if status != session["status"]:
        session["since"] = now

    session["status"], session["detail"] = status, detail


def main():
    try:
        event = json.load(sys.stdin)
    except ValueError:
        return

    if not isinstance(event, dict):
        return

    OUT.parent.mkdir(parents=True, exist_ok=True)

    # several sessions may fire hooks at the same time
    with open(OUT.parent / ".claude-code-sessions.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)

        try:
            sessions = json.loads(OUT.read_text(encoding="utf-8")).get("claudeCodeSessions") or {}
        except (OSError, ValueError, AttributeError):
            sessions = {}

        now = time.time()
        sessions = {sid: s for sid, s in sessions.items() if now - s.get("seen", 0) < STALE_AFTER_S}

        apply_event(sessions, event, now)

        fd, tmp = tempfile.mkstemp(prefix=".runcat-", suffix=".tmp", dir=str(OUT.parent))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(build_card(sessions), f, ensure_ascii=False)
        os.replace(tmp, OUT)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never break Claude Code
        print(f"runcat hook: {e}", file=sys.stderr)
    sys.exit(0)
