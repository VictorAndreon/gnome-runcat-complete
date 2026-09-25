# GPU

Shows GPU usage, VRAM, temperature and power draw, with usage in the top bar. Works with
NVIDIA (proprietary driver, through `nvidia-smi`) and AMD (`amdgpu` driver, through sysfs).

## Setup

```sh
install -Dm 755 runcat-gpu.py ~/.local/bin/runcat-gpu.py
~/.local/bin/runcat-gpu.py --once   # check that it finds your GPU

install -Dm 644 runcat-gpu.service ~/.config/systemd/user/runcat-gpu.service
systemctl --user daemon-reload
systemctl --user enable --now runcat-gpu.service
```

The service writes `~/.config/runcat/metrics/gpu.json` every 3 seconds
(`RUNCAT_GPU_INTERVAL` changes it). Stop it with
`systemctl --user disable --now runcat-gpu.service` and delete the file to remove the card.
