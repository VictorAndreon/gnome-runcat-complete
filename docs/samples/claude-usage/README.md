# Claude usage limits

Shows the 5-hour and 7-day usage limits of your Claude subscription, with their reset
times, in a "Claude" card with the Claude spark icon. The top bar shows both, e.g.
`23% · 41%`.

Works whether you use Claude Code in the terminal or in the desktop app: limits are
account-wide, so the card takes them from the freshest local source:

- the [`claude-code-usage`](../claude-code-usage/) status line, live after every turn of a
  **terminal** session;
- the usage cache Claude Code keeps in `~/.claude.json`, refreshed when `/usage` is opened
  (the desktop app has no status line).

Values older than 30 minutes show their age. A window that has reset since shows `0%` if
Claude wasn't used afterwards, `—` otherwise — the real value is unknown until one of the
sources above updates.

## Setup

1. Set up the [`claude-code-usage`](../claude-code-usage/) status line, writing to a hidden
   file so RunCat doesn't show it as a second card:

   ```json
   "command": "RUNCAT_OUT_FILE=$HOME/.config/runcat/metrics/.claude-statusline.json ~/.claude/runcat-statusline.py"
   ```

2. Install the script, the icon and the timer (it refreshes the card every minute):

   ```sh
   install -Dm 755 runcat-claude-usage.py ~/.local/bin/runcat-claude-usage.py
   install -Dm 644 claude-spark-symbolic.svg ~/.local/share/icons/hicolor/scalable/apps/claude-spark-symbolic.svg

   install -Dm 644 runcat-claude-usage.service runcat-claude-usage.timer -t ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now runcat-claude-usage.timer
   ```

3. Restart GNOME Shell once so it picks up the new icon.

The card is written to `~/.config/runcat/metrics/claude-usage.json`. Remove it with
`systemctl --user disable --now runcat-claude-usage.timer` and delete the file.

## Notes

- Rate limits are only reported for Claude.ai Pro/Max subscriptions.
- The labels are in Brazilian Portuguese (`Semanal`, `reinicia`, `há 2 h`); change
  `WINDOWS`, `age()` and `limit_row()` for another language.
- The icon is a symbolic SVG: the theme recolors it like the other card icons.
