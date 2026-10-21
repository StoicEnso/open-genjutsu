# Third-party components

The Open Genjutsu application is MIT licensed. Dependencies retain their original notices in their installed packages. This file is an inventory, not a replacement for those licenses.

| Component | License / role | Source |
| --- | --- | --- |
| React and React DOM | MIT; interface | https://github.com/facebook/react |
| Lucide | ISC; interface icons | https://github.com/lucide-icons/lucide |
| Express | MIT; local HTTP server | https://github.com/expressjs/express |
| Multer | MIT; bounded media uploads | https://github.com/expressjs/multer |
| Zod | MIT; validation | https://github.com/colinhacks/zod |
| yazl | MIT; streamed project ZIP export | https://github.com/thejoshwolfe/yazl |
| proper-lockfile | MIT; exclusive workspace ownership | https://github.com/moxystudio/node-proper-lockfile |
| Comfy TypeScript SDK | MIT; official local job protocol | https://github.com/Comfy-Org/comfy-typescript-sdk |
| Electron | MIT plus Chromium/Node and third-party notices bundled with its runtime; desktop shell | https://github.com/electron/electron |
| ComfyUI | GPL-3.0; separately installed local inference server | https://github.com/Comfy-Org/ComfyUI |
| comfy-api-proxy | MIT; separately installed SDK adapter | https://github.com/Comfy-Org/comfy-api-proxy |
| ComfyUI-GGUF | Apache-2.0; separately installed quantized text encoder loader | https://github.com/city96/ComfyUI-GGUF |
| Wan / VACE weights | See each pinned model's actual license and pack provenance; separately downloaded | https://github.com/ali-vilab/VACE |
| FFmpeg / FFprobe | Separately installed executables; their configured build license applies. No FFmpeg binary is distributed by this project. | https://ffmpeg.org/legal.html |

Do not assume an npm wrapper's license applies to a downloaded binary, or that a quantized weight file changes the upstream model's terms. In particular, the macOS ARM binary supplied by ffmpeg-static b6.1.1 was inspected during development, found configured with `--enable-nonfree`, and excluded from the distributable application.

No model weights, Higgsfield code bundles, third-party demonstration clips, or account credentials are included.
