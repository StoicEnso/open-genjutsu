# Public media credits — 23 October 2026

The new portrait assets are a disclosed **AI animation of a historical photograph**, driven by a separate historical film. They are not authentic footage of Abraham Lincoln, evidence of an actual meeting, or an institutional endorsement.

- Driving film: **Fred Ott’s Sneeze (1894)**. [Library of Congress catalog](https://www.loc.gov/item/00694192/), downloaded from the [Wikimedia Commons derivative](https://commons.wikimedia.org/wiki/File:Fred_Ott%27s_Sneeze_(1894).webm). The original film is public domain by age; Commons records its copyright status. Actual downloaded source: 1440×1080, 24fps, 68 decoded frames, 2.833 seconds.
- Still reference: **Abraham Lincoln, frontal portrait (1863)**. [Library of Congress catalog and rights statement](https://www.loc.gov/item/2002725260/); the catalog states no known restrictions on publication. The prepared face crop retains the photographic sepia appearance.
- Model: [LivePortrait](https://github.com/KwaiVGI/LivePortrait), MIT core and five pinned core weights. Open Genjutsu supplies the manual preparation, Comfy adapter, app workflow and export. This is not a new foundation model. Exact source/weight revisions are in [models.json](../scripts/portrait/models.json).

The generated take is **41 frames at16fps, 2.5625seconds**, starting0.125seconds into the film, with visible motion amount0.65 and manual square crops. It completed through the app in41.2seconds on an M4 Pro/24GB Mac. All41 prepared-driver/output frame pairs were reviewed. The model transfers a milder portrait interpretation of the head movement; it does not transfer the hand or reproduce the sneeze exactly. Eyelid softening and slight ear/hair warping remain.

[The34.25-second silent showcase](assets/2026-10-23-open-genjutsu-showcase-Codex.mp4) combines the title, labelled normal-speed comparison, actual app screenshot, export explanation, limits and credits. It is an edited technical presentation, not an uncut screen recording.

[The comparison](assets/2026-10-23-human-portrait-comparison-Codex.mp4) repeats the full take four times at normal speed, total10.25seconds. Source/reference display scaling is presentation only. The [raw generated take](assets/2026-10-23-historical-portrait-output-Codex.mp4) is512×512. There is no restoration, frame interpolation, slow motion, soundtrack or paid generation. [The screenshot](assets/2026-10-23-working-mac-app-Codex.png) is the actual locally running Mac app frontend in Chrome, with the saved take reopened; it contains no browser headers or unrelated user data.

[Machine-readable provenance](2026-10-23-public-media-provenance-Codex.json) records original/prepared-input and released-file hashes plus exact crop parameters. The full project ZIP remains available in the local review workspace. Modern stock benchmarks and all modern-stock-derived outputs remain private and are excluded from this repository.

Historical copyright status does not establish acceptance of the competition’s likeness declaration. No organizer ruling or final application submission is claimed.
