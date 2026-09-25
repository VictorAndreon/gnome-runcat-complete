# Claude Code sessions (hooks)

Shows every running Claude Code session by project folder and what it's doing:

- **Working** — processing a prompt (with the tool currently running)
- **Waiting for you** — a permission prompt or an idle prompt needs your answer
- **Done** — the turn finished

The top bar shows `⚠ 2` when two sessions are waiting for you, `⋯ 1` when one is working
and `✓` when all are done — handy when Claude runs in a terminal you can't see.

It uses [Claude Code hooks](https://code.claude.com/docs/en/hooks): each event runs the script,
which updates `~/.config/runcat/metrics/claude-code-sessions.json`.

## Setup

1. Install the script:

   ```sh
   install -m 755 runcat-hook.py ~/.claude/runcat-hook.py
   ```

2. Add the hooks to `~/.claude/settings.json` (merge with your existing `hooks`, if any):

   ```json
   {
     "hooks": {
       "SessionStart":     [{ "hooks": [{ "type": "command", "command": "~/.claude/runcat-hook.py", "timeout": 5 }] }],
       "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "~/.claude/runcat-hook.py", "timeout": 5 }] }],
       "PreToolUse":       [{ "hooks": [{ "type": "command", "command": "~/.claude/runcat-hook.py", "timeout": 5 }] }],
       "Notification":     [{ "hooks": [{ "type": "command", "command": "~/.claude/runcat-hook.py", "timeout": 5 }] }],
       "Stop":             [{ "hooks": [{ "type": "command", "command": "~/.claude/runcat-hook.py", "timeout": 5 }] }],
       "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "~/.claude/runcat-hook.py", "timeout": 5 }] }]
     }
   }
   ```

   `PreToolUse` is optional: without it the card doesn't show which tool is running.

3. Restart Claude Code (run `/hooks` to review them).

## Notes

- The script prints nothing and always exits with 0, so it can never block or change what
  Claude does.
- Sessions that stop sending events for 12 hours (closed terminal, crash) are dropped.
- Build your own: any hook can call [`runcat-metric`](../tools/runcat-metric), e.g. a
  `PostToolUse` hook on `Bash` that reports your last test run.
