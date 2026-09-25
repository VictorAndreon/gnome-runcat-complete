# Claude Code usage

Shows the current model, context window usage, the 5-hour and 7-day rate limits (with
their reset times) and the session cost. The top bar value is the 5-hour limit usage
(or the context usage on plans without rate limits).

Claude Code runs its [status line](https://code.claude.com/docs/en/statusline) command after
every turn with the session data on stdin; this script turns it into a card.

## Setup

1. Install the script:

   ```sh
   install -m 755 runcat-statusline.py ~/.claude/runcat-statusline.py
   ```

2. Register it in `~/.claude/settings.json`:

   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "~/.claude/runcat-statusline.py"
     }
   }
   ```

3. Use Claude Code. After the first answer, `~/.config/runcat/metrics/claude-code.json`
   appears and the card shows up in RunCat's menu.
4. Optional: **Preferences → Custom metrics**, switch on "Claude Code" to see the 5-hour
   usage next to the cat.

## Already have a status line?

Claude Code accepts a single status line command. Pass yours as arguments: it receives the
same input, and its output is what Claude Code displays.

```json
"command": "~/.claude/runcat-statusline.py ~/.claude/my-statusline.sh"
```

## Notes

- Rate limits are only reported for Claude.ai Pro/Max subscriptions, after the first API
  response of a session. They are account-wide, so the script remembers the last values
  (until they reset) when a fresh session updates the card.
- The context and cost rows belong to the session that ran most recently.
- `RUNCAT_OUT_FILE` changes the output file.
- Check what it writes: `python3 -m json.tool ~/.config/runcat/metrics/claude-code.json`.
