# Pinned Apple Silicon runtime

Created 21 October 2026. This optional recipe reconstructs the source revisions, Python packages and three model files used for the successful local VACE preview. It creates a new directory and refuses to alter an existing one. It does not modify another Comfy installation.

Requires Apple Silicon macOS, Python 3.12, Git, curl, and enough disk space for **8,218,471,390 bytes of model weights**, the Python environment, source, temporary downloads and outputs. It uses no paid API or GPU service. Install local FFmpeg/FFprobe separately; they are not bundled.

Read the script and model licenses before running it. The working runtime was installed and exercised with these pins. The combined bootstrap script has passed shell syntax checks; a second complete clean installation has not been run.

```bash
# From the repository root. Choose a NEW directory.
export OPEN_GENJUTSU_PYTHON=/opt/homebrew/opt/python@3.12/bin/python3.12
bash runtime/2026-10-21-runtime-bootstrap-Codex.sh \
  "$HOME/.local/share/2026-10-21-open-genjutsu-runtime-Codex"
```

Run the generated `2026-10-21-start-core-Codex.sh` and `2026-10-21-start-proxy-Codex.sh` in separate terminals. Then launch the app. In **Engine**, use native ComfyUI `http://127.0.0.1:8188` and SDK proxy `http://127.0.0.1:8189`.

The script retrieves official ComfyUI commit `d52a7a5ef60b36062f7c3c69bd774f4c98b56eb0` and ComfyUI-GGUF commit `6ea2651e7df66d7585f6ffee804b20e92fb38b8a`. Each model download uses a pinned Hugging Face revision and is published from a temporary filename only after its size and SHA-256 match the [manifest](2026-10-21-model-download-manifest-Codex.json). The generated launchers unset `COMFY_API_KEY` and start ComfyUI in offline mode.

Start with **VACE 1.3B — Local Preview**, 256×256 and 17 frames. The four-step preset verifies execution; the twenty-step preset was also run through the app. Their hand anatomy and identity quality are limited. This recipe does not download or validate the 14B Wan Animate backend.

On the tested 24GB M4 Pro, the small run succeeded but the system entered significant memory pressure. Process RSS does not include all GPU allocations. Close unused applications and avoid assuming that larger resolutions or longer clips will fit. The app queues jobs sequentially; it does not automatically unload another user's Comfy work.

Sources and licenses: [ComfyUI](https://github.com/Comfy-Org/ComfyUI) (GPL-3.0), [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) (Apache-2.0), [Comfy API proxy](https://github.com/Comfy-Org/comfy-api-proxy), and the model repositories listed in the manifest (Apache-2.0). The application MIT license does not replace these licenses.
