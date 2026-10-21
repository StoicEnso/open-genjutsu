# Verification record

Created 21 October 2026. Results are from this development build on an Apple Silicon M4 Pro with 24GB unified memory. No paid generation, GPU rental or cloud API was used.

## Actual model execution

Both inputs were original procedural illustrations: a [red figure waving](assets/2026-10-21-source-wave-Codex.mp4) and a [blue/gold robot reference](assets/2026-10-21-reference-robot-Codex.png). The [raw local result](assets/2026-10-21-raw-local-result-Codex.mp4) is also retained. The README comparison shows the actual twenty-step output. Neither test establishes human identity preservation, background preservation or parity with a commercial model.

| Check | Observed result |
| --- | --- |
| VACE 1.3B, four steps, 256×256, 17 frames | Succeeded via official Python SDK and local proxy; 97.34 seconds end to end, about nine seconds denoising. |
| VACE 1.3B, twenty steps, 256×256, 17 frames | Succeeded through the app's official Node SDK path. Comfy execution about 93.68 seconds; about 41 seconds sampling. Output is 23,311 bytes, 0.708333 seconds. |
| App recovery | Native SaveVideo history labelled MP4 media as an image with zero size metadata. Actual file probing now accepts the video safely; the saved remote job was recovered without submitting another generation. |
| Project export | Downloaded ZIP contains prepared source, original source, reference, output, workflow pack, portable API graph, SDK receipt and manifest. Input and output hashes checked against actual files. |

The twenty-step remote receipt ID is `6f92c9ae-75a4-4f8d-9301-c252aaac2d12`; local job ID is `05804c6a-ecec-44bf-a632-d6995cec1b4b`. App wall time included recovering the metadata mismatch and is not a clean inference benchmark. More sampling steps are not evidence of better output quality.

During the four-step test, peak Comfy process RSS was about 4.97GB, excluding GPU/driver allocations. Minimum system available memory was about 0.90GB. System swap increased from about 18.46GB to 27.00GB while other user applications were active; that increase cannot be attributed exclusively to this job. After confirming the task-owned queue was empty, releasing its model caches recovered available memory. No higher-resolution or 14B performance claim is supported.

## Application verification

All **10 server tests passed** and the TypeScript, Vite and server production build succeeded. A production-dependency audit reported zero known vulnerabilities; development tooling is outside that result.

The server suite exercises the official SDK against a mock local protocol, including submission, polling, downloads, durable recovery, immutable reruns, portable exports, workspace ownership, origin/host restrictions, unsafe URLs and media validation. Mock tests are distinct from the real model runs above.

Hidden, isolated Electron UI checks exercise the built frontend: real file uploads using clearly labelled transport fixtures, engine dialog and Escape dismissal, workflow graph inspection, empty library, and a 390px viewport without horizontal overflow. A separate read-only check reopens the actual completed model job, loads both videos, switches comparison layout during playback and verifies all four export links. No new generation is requested by either UI check. Visual review caught and corrected a wipe-divider layout bug that hid the result.

The packaged arm64 Mac application was actually launched with a fresh workspace and hidden window. Its local health endpoint, all three bundled workflow packs and built HTML were verified before closing the test process. No generation was requested during this startup check.

The Mac package is an unsigned development build. It contains application code, not model weights or a Python/FFmpeg runtime. Apple notarization, distribution to other machines, human recasting, long clips, remote servers and provider BYOK remain unverified or unimplemented as described in the README.

## Reproduce checks

```bash
npm ci
npm test
npm run build
npm run package:mac

# Optional: set a dated output directory for screenshots and checks.
OPEN_GENJUTSU_QA_DIR=/absolute/path/to/2026-10-21-qa-Codex \
  node_modules/.bin/electron scripts/desktop-smoke.cjs
```

The completed-job UI script additionally requires an already succeeded job, `OPEN_GENJUTSU_QA_BASE_URL`, and `OPEN_GENJUTSU_QA_JOB_ID`. It refuses to request generation. A real reproduction needs the local runtime and the models listed in the pinned manifest.
