# Custom metrics

Anything you can write to a file can become a card in RunCat's menu: Claude Code usage,
the state of your Claude Code sessions, GPU load, a backup status, a stock price…

A script, cron job, systemd timer or hook writes a small JSON file, and RunCat watches the
file and updates the card as soon as it changes. RunCat itself never runs your scripts and
never goes to the network.

```
your script / hook ──writes──▶ ~/.config/runcat/metrics/<name>.json ──watched by──▶ RunCat card
```

## Quick start

1. Write a file to `~/.config/runcat/metrics/` — every `*.json` there shows up automatically:

   ```sh
   mkdir -p ~/.config/runcat/metrics
   cat > ~/.config/runcat/metrics/hello.json <<'JSON'
   {
     "title": "Hello",
     "icon": "sparkle",
     "metricsBarValue": "42%",
     "metrics": [
       { "title": "Status", "formattedValue": "It works" },
       { "title": "Progress", "formattedValue": "42%", "normalizedValue": 0.42 }
     ],
     "lastUpdatedDate": "2026-09-25T12:00:00Z"
   }
   JSON
   ```

2. Click the cat — the card is there.
3. Optional: in **Preferences → Custom metrics**, flip the source's switch to also show
   `metricsBarValue` in the top bar.

Files stored somewhere else (e.g. a tool that insists on its own folder) can be added with
**Preferences → Custom metrics → Add file**.

## The `runcat-metric` helper

[`samples/tools/runcat-metric`](samples/tools/runcat-metric) writes the file for you, atomically,
so a metric is one line in any shell script or hook:

```sh
install -m 755 docs/samples/tools/runcat-metric ~/.local/bin/

runcat-metric write backup --title "Backup" --icon drive-harddisk-symbolic \
    --row "Last run" "$(date +%H:%M)" \
    --bar "Disk" "71%" 0.71 \
    --panel "OK"

runcat-metric remove backup
```

## Samples

| Sample | What it shows | Fed by |
|---|---|---|
| [`claude-code-usage`](samples/claude-code-usage/) | Model, context window, 5-hour and 7-day limits, session cost | Claude Code status line |
| [`claude-code-hooks`](samples/claude-code-hooks/) | Every Claude Code session: working, waiting for you, done | Claude Code hooks |
| [`gpu`](samples/gpu/) | GPU usage, VRAM, temperature, power (NVIDIA and AMD) | systemd user service |

## File format

The format is compatible with
[RunCat Neo's custom metrics](https://github.com/runcat-dev/RunCatNeo/blob/main/docs/CustomMetricsSchema.md),
so files written for the macOS app work here too.

### Top level

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Card title. |
| `metrics` | array of Metric | yes | Card rows. May be empty. |
| `lastUpdatedDate` | string | no | ISO 8601 date the file was written, shown as "Updated 3 minutes ago". Falls back to the file modification time. |
| `metricsBarValue` | string | no | Short text for the top bar, shown verbatim. `---` when missing. |
| `icon` | string | no | *Linux only.* A bundled icon (`cpu`, `memory`, `temperature`, `chart`, `sparkle`, `gpu`), an icon theme name (`weather-clear-symbolic`) or an absolute path to an SVG/PNG. |
| `symbol` | string | no | RunCat Neo's SF Symbol name. Common ones are mapped to bundled icons when `icon` is missing. |

Unknown fields are ignored, so producers can keep their own state in the file.

### Metric

| Field | Type | Required | Description |
|---|---|---|---|
| `title` | string | yes | Row label, displayed as `title: formattedValue`. |
| `formattedValue` | string | yes | Value displayed verbatim: include units, rounding and so on. |
| `normalizedValue` | number | no | Value in `[0, 1]` (clamped). When present a bar is drawn under the row. |

## Rules of thumb

- **Write atomically**: write a temporary file in the same folder and `mv` it into place, so
  RunCat never reads a half-written file. Files starting with `.` are ignored, which makes
  `.tmp-*` names safe. `runcat-metric` and the samples do this.
- **Keep it small**: files over 1 MiB are rejected, the file is re-read on every change.
- **Any cadence**: write every second or once a day, RunCat reacts to file changes.
- **Errors**: if the file disappears or contains invalid JSON, the card keeps the last good
  values with a red "Failed to read" footer, and the top bar shows `---`. RunCat retries every
  5 seconds and recovers on its own.
- **Removing a card**: delete the file (or remove it in preferences if you added it there).
