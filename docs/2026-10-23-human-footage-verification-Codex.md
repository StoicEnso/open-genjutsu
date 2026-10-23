# Human-footage verification — 23 October 2026

Created 23 October 2026, Europe/London. Open Genjutsu v0.2.

## What is working

Real human footage drives a photographic portrait through the app's official Comfy SDK, a self-hosted proxy and a new offline Comfy node. The stronger tested lane is **small frontal portrait motion**, with explicit square crops. It retains the reference's appearance and transfers approximate eyelid movement. This is a local portrait beta, not full-body recasting, source-scene preservation or Higgsfield quality parity.

The custom node calls the MIT LivePortrait core directly. It never initializes the upstream automatic cropper, InsightFace, a face detector, external landmark models or animal models. Five pinned, SHA-256-verified core weights total **522,320,239 bytes**. The private package name avoids shadowing another Comfy node's `src`. The installer reads committed source blobs, verifies bounded model downloads/copies, stages in a disabled directory, and installs with a same-filesystem rename. Runtime inference performs no downloads or provider calls.

## Actual local executions

All rows below used an M4 Pro with 24GB unified memory. Inputs are square 256px crops; the portrait model decodes 512px output. Timings describe this machine and workload, not a general performance guarantee.

| Test | Exact selection | Outcome | Observed time |
| --- | --- | --- | --- |
| Modern adult, frontal reference | 33 frames, 16 fps,2.0625s; source6.0–8.0625s; relative motion 1.0 | Actual app/SDK run; recognizable reference and matched partial eyelid event; smoothing and eyelid asymmetry remain | 36.9s app end to end |
| Wider performance crop | Same source/reference/window/FPS/gain; only source ROI changed from560px square to720px square | Full chin/neck retained, similar eyelid event, no obvious new gross failure in all 33 frames. Prepared reference bytes unchanged. | 33.6s app end to end |
| Historical human → Lincoln | 25 frames, 24 fps,1.041667s; original film1.75s in; motion0.35 | Submitted with real Chrome upload/crop/render controls; recognizable reference and subtle bow/recovery | 26.1s app end to end |
| Fuller historical performance | 41 frames, 16 fps, 2.5625s; original film0.125s in; motion0.65 | Actual app rerun; clearer lift, turn and bow. All 41frame pairs reviewed. Some eyelid/expression softening, ear/hair halo and retained forward gaze during bow remain. | 41.2s app end to end |
| Portable historical-project replay | Exact exported API graph, bound filenames and inputs; direct local Comfy prompt, no cached nodes | All 25 decoded RGB frames exactly equal; **zero differing pixels** across 6,553,600 pixels. MP4 containers differ. | 24.737s Comfy execution |

The longer historical take is a more informative showcase, not an isolated motion-gain A/B: its source window, FPS and first-frame relative-motion baseline also differ. The source hand is not transferred, and the model turns the sneeze into milder portrait movement. The portable replay was submitted exactly once. This demonstrates a successful **same-runtime repeat**, not general determinism across devices or versions. Project ZIPs retain original uploads, exact prepared crops/windows, bound parameters, hashes, SDK receipt, portable graph and output. The modern run's portable graph retains motion 1.0 despite the pack's default 0.35.

## Quality work and limits

Earlier real-human VACE tests produced a coherent head turn but weak reference likeness, neon/plastic colors and facial drift. A controlled CFG-only change did not fix those issues. A prompt-only muted-palette change reduced saturation while retaining the same known weaknesses. That workflow remains an explicitly experimental Van Gogh painting study.

Core-only LivePortrait preserves the reference more faithfully and uses far less memory. A three-quarter painting driven through a larger head turn still showed duplicate nose/mouth traces. Reducing global motion to 0.2 made them less distracting while also attenuating the action. A frontal photographic reference worked better. The modern frontal clip shows a **partial, asymmetric source eye closure**, not a complete textbook blink. The output follows its timing but produces a softened dark eyelid/eye-socket shape. No perfect expression, detailed eyelid anatomy or photorealistic identity guarantee is supported. Native LivePortrait handles portrait animation; it is not a new model invented here.

A bounded GFPGAN v1.4 restoration experiment processed only three critical modern-output frames on MPS in 2.84 seconds. Raw restoration made the face look younger, changed hair/beard/grain and partly reopened the closing eye. A 25% blend left most blur. Parent and independent reviewer rejected integration; no full-video restoration or enhancement is used in the app or showcase.

A wider crop improved face coverage but did not cure neural smoothing. Original image grain is not recovered merely because output dimensions are 512px. Full-body/hand fidelity, arbitrary camera movement, long clips and the included14B Wan Animate pack remain unverified.

## Independent review and verification

- **19** TypeScript/SDK/media/security/helper tests passed, including real decoded crop pixels, 90-degree phone orientation, exact frame/FPS preparation, immutable reruns, scoped cancellation/recovery, origin protections and portable hashes.
- **6** Python adapter/installer protocol tests passed with tiny owned fixtures, without pretending fixture tests were real model execution.
- **15** isolated UI assertions passed for bounds, square crops, rotated legacy geometry, independent batch references, saved rerun parameters, window/FPS gates and prepared-source comparison. Their HTTP actions were intercepted inert fixtures.
- The desktop UI smoke check passed real procedural uploads, workflow inspection, dialog dismissal and390px overflow checks. The unsigned ARM64 Mac package built and launched with the saved historical project; its local API reported the completed job and ready portrait engine. It requires external ComfyUI/Python/models/proxy and FFmpeg.
- Parent and independent technical reviewer inspected all 33 modern driver/output frames and full-size critical eyelid frames. Gemini4 Argon High was actually invoked through the existing authenticated Antigravity CLI1.4.6. Its reviews saw sampled video frames and all-frame contact sheets; results were correctly **partial for continuous playback**, not invented native-video/audio coverage. Reviewers confirmed the timing/appearance improvement while flagging the dark eyelid trough, smoothing, narrow motion range and weak short public showcase. These are agent critiques, not feedback from competition judges.
- Actual Chrome playback was checked on the packaged app's local server. The tab can suspend while inactive/occluded; when active, both source/output reach their true end and the controls reflect it. This is not a frame-perfect synchronization guarantee.

No paid provider API, cloud GPU, purchase or new paid subscription was used. Gemini consumed the existing account's quota; token usage is not a dollar-spend or remaining-quota measurement.

## Public assets and competition status

**24 October revision:** Historical-person media has been archived outside the current submission version. The earlier comparison, raw take, app screenshot and showcase are not included in this branch’s current tree. Timings, limitations, source credits and prior replay evidence remain documented as text; see [media scope](2026-10-24-submission-media-scope-Codex.md).

The archived historical test was derived from **Fred Ott's Sneeze (1894)**, attributed to the Library of Congress via the [Commons derivative](https://commons.wikimedia.org/wiki/File:Fred_Ott%27s_Sneeze_(1894).webm). Actual downloaded container:1440×1080,24 fps,68decodedframes,2.833s. The [LOC catalog record](https://www.loc.gov/item/00694192/) and [LOC public-domain guidance](https://www.loc.gov/duplicationservices/copyright/) support its historical copyright basis. The reference is the 1863 frontal [Abraham Lincoln portrait](https://www.loc.gov/item/2002725260/), whose LOC record states no known restrictions on publication. Digital crops, timing and motion gain are disclosed. No institutional endorsement is implied.

Modern stock source and generated outputs remain **private**; a copyright stock license is not evidence of a model's permission for this public AI demo. A consenting participant's original clip is still the preferred final demonstration. The competition's likeness declaration has no explicit historical-material exception; no organizer ruling has been obtained.

The [rules checked on 23 October](https://comfy.org/open-source-higgsfield/) permit entirely local ComfyUI and allow one submission per person. The [approved announcement](https://x.com/ihusanadam00/status/2113773037052940582) was published on 24 October; the final competition application has not been submitted. The source is releasable as a portrait beta; the current evidence does not justify declaring the entire competition entry ready or promising a win.
