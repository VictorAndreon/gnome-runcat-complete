#!/usr/bin/env python3
"""
RunCat for GNOME — GPU card (NVIDIA via nvidia-smi, AMD via sysfs).

Writes ~/.config/runcat/metrics/gpu.json every few seconds with GPU usage,
VRAM usage, temperature and power draw.

    runcat-gpu.py            # loop forever (use the systemd user service)
    runcat-gpu.py --once     # write a single snapshot and exit

RUNCAT_OUT_FILE overrides the output file, RUNCAT_GPU_INTERVAL the interval (seconds).
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
OUT = Path(os.environ.get("RUNCAT_OUT_FILE") or CONFIG_DIR / "runcat" / "metrics" / "gpu.json")
INTERVAL = float(os.environ.get("RUNCAT_GPU_INTERVAL") or 3)


def read_number(path):
    try:
        return float(Path(path).read_text().strip())
    except (OSError, ValueError):
        return None


def nvidia_gpus():
    if not shutil.which("nvidia-smi"):
        return []
    fields = "name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw"
    try:
        output = subprocess.run(
            ["nvidia-smi", f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []

    def num(value):
        try:
            return float(value)
        except ValueError:  # "[N/A]"
            return None

    gpus = []
    for line in output.strip().splitlines():
        name, usage, used, total, temperature, power = [part.strip() for part in line.split(",")]
        gpus.append({
            "name": name,
            "usage": num(usage),
            "vram_used": num(used) * 1024 ** 2 if num(used) is not None else None,
            "vram_total": num(total) * 1024 ** 2 if num(total) is not None else None,
            "temperature": num(temperature),
            "power": num(power),
        })
    return gpus


def amd_gpus():
    gpus = []
    for device in sorted(glob.glob("/sys/class/drm/card[0-9]*/device")):
        usage = read_number(f"{device}/gpu_busy_percent")
        if usage is None:
            continue
        hwmon = next(iter(glob.glob(f"{device}/hwmon/hwmon*")), None)
        temperature = read_number(f"{hwmon}/temp1_input") if hwmon else None
        power = read_number(f"{hwmon}/power1_average") if hwmon else None
        if power is None and hwmon:
            power = read_number(f"{hwmon}/power1_input")
        gpus.append({
            "name": "AMD GPU",
            "usage": usage,
            "vram_used": read_number(f"{device}/mem_info_vram_used"),
            "vram_total": read_number(f"{device}/mem_info_vram_total"),
            "temperature": temperature / 1000 if temperature is not None else None,
            "power": power / 1e6 if power is not None else None,
        })
    return gpus


def gib(value):
    return f"{value / 1024 ** 3:.1f} GiB"


def build_card(gpus):
    rows = []
    for i, gpu in enumerate(gpus):
        prefix = f"GPU {i} " if len(gpus) > 1 else ""
        if gpu["usage"] is not None:
            rows.append({"title": f"{prefix}Usage", "formattedValue": f"{gpu['usage']:.0f}%",
                         "normalizedValue": round(gpu["usage"] / 100, 4)})
        if gpu["vram_used"] is not None and gpu["vram_total"]:
            rows.append({"title": f"{prefix}VRAM",
                         "formattedValue": f"{gib(gpu['vram_used'])} / {gib(gpu['vram_total'])}",
                         "normalizedValue": round(gpu["vram_used"] / gpu["vram_total"], 4)})
        if gpu["temperature"] is not None:
            rows.append({"title": f"{prefix}Temperature", "formattedValue": f"{gpu['temperature']:.0f} °C"})
        if gpu["power"] is not None:
            rows.append({"title": f"{prefix}Power", "formattedValue": f"{gpu['power']:.0f} W"})

    card = {
        "title": gpus[0]["name"] if len(gpus) == 1 else "GPU",
        "icon": "gpu",
        "metrics": rows,
        "lastUpdatedDate": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if gpus[0]["usage"] is not None:
        card["metricsBarValue"] = f"{gpus[0]['usage']:.0f}%"
    return card


def write_atomically(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".runcat-", suffix=".tmp", dir=str(path.parent))
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


def main():
    once = "--once" in sys.argv[1:]
    while True:
        gpus = nvidia_gpus() or amd_gpus()
        if not gpus:
            print("runcat-gpu: no supported GPU found (needs nvidia-smi or the amdgpu driver)", file=sys.stderr)
            sys.exit(1)
        write_atomically(OUT, build_card(gpus))
        if once:
            return
        time.sleep(INTERVAL)


if __name__ == "__main__":
    main()
