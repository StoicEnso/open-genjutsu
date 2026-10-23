# Public media credits — 23 October 2026

**24 October revision:** The historical media described below is archived outside the current competition submission version. Its textual credits and provenance are retained; the current fictional-character demo is documented in [local demo provenance](2026-10-23-local-demo-provenance-Codex.json). No Git history was rewritten.

The earlier portrait assets were a disclosed **AI animation of a historical photograph**, driven by a separate historical film. They are not authentic footage of Abraham Lincoln, evidence of an actual meeting, or an institutional endorsement.

- Driving film: **Fred Ott’s Sneeze (1894)**. [Library of Congress catalog](https://www.loc.gov/item/00694192/), downloaded from the [Wikimedia Commons derivative](https://commons.wikimedia.org/wiki/File:Fred_Ott%27s_Sneeze_(1894).webm). The original film is public domain by age; Commons records its copyright status. Actual downloaded source: 1440×1080, 24fps, 68 decoded frames, 2.833 seconds.
- Still reference: **Abraham Lincoln, frontal portrait (1863)**. [Library of Congress catalog and rights statement](https://www.loc.gov/item/2002725260/); the catalog states no known restrictions on publication. The prepared face crop retains the photographic sepia appearance.
- Model: [LivePortrait](https://github.com/KwaiVGI/LivePortrait), MIT core and five pinned core weights. Open Genjutsu supplies the manual preparation, Comfy adapter, app workflow and export. This is not a new foundation model. Exact source/weight revisions are in [models.json](../scripts/portrait/models.json).

The generated take is **41 frames at16fps, 2.5625seconds**, starting0.125seconds into the film, with visible motion amount0.65 and manual square crops. It completed through the app in41.2seconds on an M4 Pro/24GB Mac. All41 prepared-driver/output frame pairs were reviewed. The model transfers a milder portrait interpretation of the head movement; it does not transfer the hand or reproduce the sneeze exactly. Eyelid softening and slight ear/hair warping remain.

The archived 34.25-second silent showcase combined labelled comparison, an actual app screenshot, export explanation, limits and credits. It was an edited technical presentation, not an uncut screen recording. The 10.25-second comparison repeated the full take four times at normal speed. The raw generated take was 512×512, without restoration, interpolation, slow motion or audio.

[Archived machine-readable provenance](2026-10-23-public-media-provenance-Codex.json) retains hashes and exact crop parameters for audit. These files are not part of the current branch’s media tree or the current demo page. Modern stock benchmarks and derivatives also remain private. See the [current submission media scope](2026-10-24-submission-media-scope-Codex.md).

Historical copyright status does not establish acceptance of the competition’s likeness declaration. No organizer ruling or final application submission is claimed.
