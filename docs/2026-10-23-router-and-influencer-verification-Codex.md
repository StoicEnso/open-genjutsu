# Router and fictional-character verification

Created 23 October 2026, Europe/London. Open Genjutsu v0.3. This records tested behavior and remaining limits, not competition-judge feedback.

## What is implemented

**Local** stays selected by default and needs no account key. A separate **Comfy Router** studio implements BYOK for the fixed hosted model `byteplus/dreamina-seedance-2-0-260128` (Seedance 2.0 reference video). This is an optional paid route, not an automatic fallback or an imported provider-node graph.

The browser/server connection keeps the key in the app-server session. The Mac app can optionally remember it through Electron `safeStorage`: a `0600` ciphertext file in `app.getPath('userData')/credentials/comfy-router.encrypted`, under a `0700` directory, encrypted using the OS-backed key. The API secret itself is not stored directly as a Keychain database item. Unavailable or plaintext-only encryption is rejected. No key is written to browser storage, source control, signed media URLs, public job receipts or project exports. Real macOS unlock behavior has not been separately exercised in this verification.

The quote operation requires explicit consent before uploading the **whole original** video and reference to Comfy storage. It does not use Local mode’s crop or start selection. Supported inputs are MP4/MOV up to 15 seconds and 20 MB, and PNG/JPEG up to 10 MB. Uploaded media may be retained by Comfy. A valid returned USD estimate opens a separate review of files, model and settings; the user must then approve one paid request. Edits invalidate the reviewed quote.

The workspace needs a real Comfy API key, Asset API and estimate access, model-queue permission and sufficient Comfy funds. Higgsfield website credits do not fund this route. `403`, missing estimate permission or an unusable estimate blocks generation. The estimate is rechecked before submission; an increase blocks that request. It is still an estimate, not a price lock or billing cap. Provider failures and cancellation may be billed.

## Request and recovery checks

The Router JSON API is restricted to `https://api.comfy.org/v2/models/`; SDK asset operations are restricted to `https://cloud.comfy.org/api/v2/assets`. Signed media URLs must use the audited HTTPS Google storage host. Redirects do not carry credentials elsewhere. Local SDK calls remain loopback-only without inherited cloud keys, and imported workflow graphs still cannot run unaudited provider nodes.

A quote is consumed before the first asynchronous create step, with an admission guard and a separate UI submission guard. One approval admits one generation POST. An uncertain response is recorded as interrupted rather than automatically retried. When a receipt exists, recovery follows that request without another generation. Cancellation arriving before the initial receipt is saved is dispatched after the receipt arrives. Per-request deadlines remain active alongside caller cancellation. Shutdown aborts quote/tracking operations before waiting for HTTP handlers, while workspace ownership is retained until handlers stop.

Keys, raw provider errors and signed input URLs are omitted from the public response/receipt contract. Private `cloud-state.json` does retain the signed native input links for tracking; it is a restricted local state file, not an encrypted credential vault. A corrupt cloud history blocks hosted operations while keeping Local mode available.

Verification completed before this document:

| Check | Evidence and scope |
| --- | --- |
| Automated application tests | **35/35 passed**, including **11 backend cloud protocol tests**. SDK/HTTP behavior used injected fake transport and owned fixtures; no real provider key or paid call. |
| UI cloud flow | **11/11 mock cloud-flow checks**: separate upload/payment consent, exact quote review, one-shot submission and recovery controls. HTTP actions were inert fixtures. |
| Existing Local UI checks | **15/15 passed** for crops, bounds, window/FPS, batch references, reruns and prepared-source comparison. |
| Python portrait adapter/installer | **6/6 protocol tests passed**, with tiny owned fixtures, separate from actual model runs. |
| Independent lifecycle regression | Fake transport observed one generation POST, deferred receipt-bound cancellation and status-only polling. A stalled-transport test verified combined request/caller cancellation with a shortened fake timer. |
| Build and source checks | TypeScript/frontend/server build and whitespace diff check passed. |
| Desktop package | The final unsigned v0.3 ARM64 package built with the shutdown fix and launched successfully. Its local API reported version 0.3.0, no configured cloud key and zero cloud jobs. The packaged app rendered neutral Rowan in **50.117 s**; the saved take was reopened through the same local server in the owner’s Chrome using OpenSky. |
| Exported current projects | Both final casts’ ZIP contents were checked against original/prepared input hashes, exact output bytes and portable graph bindings. No new runtime replay is claimed for those casts. |

No actual paid Router generation, real provider upload/estimate permission check, final bill or hosted output-quality evaluation was performed. Protocol tests do not establish provider availability, successful real billing, or output parity. The UI makes this limitation visible. The Mac package still requires external runtime components for Local mode; this is not evidence of a second clean installation on a new machine.

## Fully local synthetic demonstration

The new primary demonstration uses independently generated fictional adults. The source performance and reference portraits were generated locally with the installed Apache-2.0 Wan2.1-VACE-1.3B stack in text-only mode, without a commercial-generated reference or control input. LivePortrait then animated the references locally. No training, fine-tuning or additional weights were used for these tests.

![Local synthetic performance and two portrait takes](assets/2026-10-23-local-casting-comparison-Codex.png)

[Comparison video](assets/2026-10-23-local-casting-comparison-Codex.mp4) · [Driving performance](assets/2026-10-23-local-driving-performance-Codex.mp4) · [Nova reference](assets/2026-10-23-nova-reference-Codex.png) · [Rowan reference](assets/2026-10-23-rowan-reference-Codex.png) · [Nova output](assets/2026-10-23-nova-output-Codex.mp4) · [Rowan output](assets/2026-10-23-rowan-output-Codex.mp4)

All runs used an M4 Pro with 24 GB unified memory. Durations below are observations for this workload. Queue-inclusive wall times must not be read as independent compute benchmarks.

| Stage | Actual settings | Observed time and qualification |
| --- | --- | --- |
| Independent local driver | 49 frames, 12 fps, 320×320; text-only Wan VACE | **421.567 s**, including CPU decoding. The resulting performance spans **4.083333 s**. |
| Nova reference | Local text-only generation, 512×512 | **87.754 s** observed. |
| Neutral-expression Rowan reference | Local text-only generation, 512×512 | **86.099 s** observed; reference SHA-256 starts `2bfab750`. |
| Nova portrait take | LivePortrait, 49 frames at 12 fps; 256px prepared input, 512px output | **50.182 s from app job creation**. |
| Neutral-expression Rowan portrait take | Same driver; separate reference and app run, job `22df80c5-cd4d-4000-b4e6-ecbaf762fa29` | **50.117 s from app job creation**. The final two takes were rendered in separate runs, not one measured 98.7-second batch. |

The earlier queued run used a different, smiling Rowan reference: that reference took about **446 s from queueing**, including wait, and its portrait take completed **98.662 s from job creation**, including waiting behind Nova. That earlier pair finished in about **98.7 s total**. Those figures are retained as earlier-run evidence, not reassigned to the final two-take comparison. The neutral revision changed the generated face, prompt and seed; it is not a mouth-only controlled A/B or a same-person identity comparison. The parent and independent media reviewer completed all-49-frame QA of the neutral revision.

The exact public input-generation graphs are [driving performance](examples/2026-10-23-local-input-generation-Codex/2026-10-23-driving-performance-Codex.json), [Nova reference](examples/2026-10-23-local-input-generation-Codex/2026-10-23-nova-reference-Codex.json) and [Rowan reference](examples/2026-10-23-local-input-generation-Codex/2026-10-23-rowan-reference-Codex.json). The [replay notes](examples/2026-10-23-local-input-generation-Codex/2026-10-23-replay-notes-Codex.json) describe their native input-generation use; they are not app workflow-pack imports. The [local demo provenance](2026-10-23-local-demo-provenance-Codex.json) records the selected media, hashes and execution evidence. These files and all five raw demo assets are included in the repository.

The actual exported [Nova project ZIP](examples/2026-10-23-local-cast-projects-Codex/2026-10-23-nova-project-Codex.zip) and [neutral-Rowan project ZIP](examples/2026-10-23-local-cast-projects-Codex/2026-10-23-rowan-project-Codex.zip) include original and prepared inputs, raw output bytes, hashes, receipts and portable bindings. Parent checks matched those contents and found no owner paths or secrets in the ZIP JSON. For exact execution, use `portable-workflow-api.json` with the bundle’s input layout and instructions. The manifest’s `workflow.graph` preserves the authored preset defaults; the actual receipt, parameters and portable graph carry the final **49 frames, 12 fps and motion 1.0**. No new runtime replay was performed for these two exports. The earlier historical 25-frame same-runtime replay is separate evidence.

The parent and independent media reviewer inspected all 49 driver/output frame pairs, including the final neutral-Rowan revision. Reference appearance and framing stayed stable within these samples, without a gross duplicate-face ghosting failure. Rowan’s brow is easier to read than Nova’s obscured brow. The neutral reference produces a clearer late frown/pout than the earlier smiling reference, with the changed-face/prompt/seed qualification above. Blink and gaze remain approximate. There is no claim of exact expression reproduction, recovered 512px detail from a 256px model input, verified unseen-profile identity, full-body fidelity or scene replacement. Normal-speed playback is distinct from sampled-frame review.

The [comparison](assets/2026-10-23-local-casting-comparison-Codex.mp4) and [vertical reaction clip](assets/2026-10-23-influencer-reaction-Codex.mp4) are each **12.25 s / 147 frames**. They repeat the 49-frame, 4.083333-second take three times at its recorded 12 fps; this does not create extra generated motion. Both complete files decoded successfully. The [58.25-second app film](assets/2026-10-23-submission-demo-Codex.mp4) was built and the parent visually reviewed its encoded opening, section boundaries, late and end frames. That inspection is not described as continuous review of every film frame.

This synthetic input is **not a real-human footage benchmark**. Earlier actual human tests remain summarized in the [human-footage report](2026-10-23-human-footage-verification-Codex.md), including private modern stock and attributed historical footage. Those results are not silently transferred to the synthetic demonstration.

## Format inspiration and source boundaries

The numeric facial-reaction format was inspired by a [Kristin Davis post](https://www.tiktok.com/@kristindavis/video/7696607238936349983), published 14 October 2026. Its public TikTok embed showed 2.1 million plays, 263,700 likes, 10,200 shares and 1,572 comments at the 23 October research snapshot. These numbers describe that source post, **not Open Genjutsu traction**. No source clip, audio, performer identity or branded scene is copied into this demo. The vertical clip’s “One more take?” counter (1 → 10 → 100) is illustrative, not measured app usage, a count of generations performed or provider pricing.

The installed last30days discovery produced no qualifying trend; Reddit coverage was degraded and authenticated/paid social sources were disabled. The specific post above was checked separately through its public platform embed. Two other format candidates had only weaker tracker evidence and are not presented as primary-verified viral results.

Modern stock and Higgsfield-generated development inputs, plus their derivative app outputs, remain private and are excluded from the new primary demo. Higgsfield’s [terms](https://higgsfield.ai/terms-of-use-agreement) allow commercial outputs generally in section 4.4 but separately restrict service/output use for developing competing products in section 5.1(iii). Its application to that earlier development use is unresolved; this document certifies neither a breach nor blanket clearance. The independent local generation avoids relying on those assets. No institutional or creator endorsement is implied.

## Submission status

The [current competition rules](https://comfy.org/open-source-higgsfield/) allow entirely local ComfyUI and **one submission per person**. The deadline is **30 October 2026, 09:00 PDT / 16:00 UTC**. The current source is on [codex/human-footage-quality](https://github.com/StoicEnso/open-genjutsu/tree/codex/human-footage-quality) while the pull request is pending.

Best Overall consideration is automatic. A usable, shareable app can be described for Most Viral without inventing adoption. No Open Weights Only claim is made for the app with its optional closed-model cloud lane. No new foundation model, first-ever motion-transfer capability, prize eligibility ruling or real judge reaction is claimed.

The final [58.25-second demonstration film](assets/2026-10-23-submission-demo-Codex.mp4), public media, graphs and provenance are published on the review branch. The [browser viewing page](https://stoicenso.github.io/open-genjutsu/2026-10-23-demo-Codex/) is live on GitHub Pages. Unauthenticated checks returned HTTP 200 for the page, both presentation videos, both project ZIPs and provenance. The hosted film reports 58.25 seconds, 1280×720 and no media error; actual playback advanced to 29.38 seconds. Layout checks at 390, 768, 1280 and 1905 CSS-pixel widths found no horizontal overflow. The page hosts prepared media only, without running the app or a model service. Final personal form answers, the required transmitted hashtagged social-post URL and the application submission remain pending. No post or application was transmitted by this documentation task, and no organizer eligibility ruling or winning outcome is implied.
