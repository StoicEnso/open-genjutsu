# Open Genjutsu — build direction

Created 21 October 2026. MIT application code; model licenses remain separate.

Build one competition submission. The official competition's first-party English translation says “One submission per person.” Additional modes belong to this application, rather than duplicate entries. Deadline: 30 October 2026, 09:00 PT.

## Product contract

A user supplies a short driving video and a character reference, selects an inspectable Comfy workflow, checks backend readiness, then queues a real render. Every job retains its exact graph, settings, inputs and outputs. A comparison view makes motion and identity failures visible. Files stay in the user's local application-data directory and are only uploaded to their configured Comfy server.

The measured default is now VACE 1.3B with a quantized text encoder, following a same-day feasibility revision. It combines a reference image and Canny conditioning for small local previews. Four-step and twenty-step 256×256/17-frame runs succeeded on this Mac, with visible hand distortion. Wan Animate 2 is also included as a heavier, unbenchmarked workflow. Neither engine promises an unchanged original background, perfect identity, or Higgsfield backend equivalence. No generated example is presented without an actual render receipt.

The UI is shared between a browser on localhost and a Mac application. Electron embeds the same local server and built frontend, keeping the official Node Comfy SDK in one implementation. We chose this over adding a second Rust backend before proving the engine. The current release only accepts loopback engines. Remote self-hosted Comfy and provider BYOK are deferred; the initial release cannot incur provider charges.

## Design reference lock

Primary source: observed Higgsfield Genjutsu page and authenticated creation form, 21 October 2026, https://higgsfield.ai/genjutsu and https://higgsfield.ai/ai/video?model=genjutsu . Reconstruct interaction contracts, not proprietary code, media, branding or server implementation.

Secondary source: Refero typography and craft-details references. A neutral, compact work interface uses one system sans family, monospaced technical metadata, labelled controls, visible keyboard focus and explicit upload/job states.

| Decision | Source and role | Reason |
| --- | --- | --- |
| Near-black stage, separated side inspector | Genjutsu's media-first creation flow | Keep the user's footage prominent while settings remain nearby |
| Source clip and character reference as separate inputs | Genjutsu motion-transfer contract | Make input responsibilities clear |
| Muted lime used only for primary action and identity mark | User brief: independent open local studio; primary action role | A visible render action without duplicating Higgsfield's branding |
| System sans with 13–15px controls, mono counters | Refero work-product typography | High scanability and offline availability |
| Empty stage with a purposeful upload target | Refero imagery rule | Avoid fabricated output imagery or borrowed proprietary samples |
| Synchronized original/result views and slider | Genjutsu before/after interaction | Help users assess motion and identity rather than trust marketing claims |
| Persistent library and exact workflow export | User's open-source/local requirement | Make jobs reopenable and results inspectable |

## Verification gates

1. Typecheck, production build and server integration tests.
2. Real local SDK/proxy round trip using a model-free video graph; label this as transport verification, never character recasting.
3. Actual tiny local model recast on this Mac, with elapsed time, memory observations and source/output provenance. Achieved with VACE 1.3B; the 14B Wan Animate pack remains unbenchmarked.
4. Upload, settings, workflow inspection, job reopen/export and responsive visual inspection. Initial owner's Chrome inspection used OpenSky. Chrome later detached task-tab control; further app tests used our own isolated hidden Electron renderer without reattaching the paused tab.
5. Build and launch the Mac app; do not claim notarization or distribution readiness for an unsigned development build.

Same-day implementation revision: batch casting now queues up to five references as separate sequential jobs. Scene reshoot exposes prompt-directed experimentation with the same engine, rather than claiming a separate model. Selected-region repair remains future work. See the [verification record](2026-10-21-verification-Codex.md) for the tested scope and quality limits.

## Evidence

- https://comfy.org/open-source-higgsfield/
- https://comfy.org/_website/translations.BFaSGuTT.js
- https://docs.comfy.org/tutorials/video/wan/wan-animate-2
- https://github.com/Comfy-Org/comfy-typescript-sdk
- https://www.electronjs.org/docs/latest/tutorial/security

No paid APIs, GPU rental, purchases, or model-generation services are authorized for this build.
