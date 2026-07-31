# 2026-07-31 — Side-on OPEN door sprite (`tile-door-open-side-v1-var-0`)

Delivered the last missing door texture for the door-rendering unification, and **retired
the previous session's "generator capability ceiling" finding** — it was a brief bug.

## Outcome

| field         | value                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| texture key   | `tile-door-open-side-v1-var-0`                                                                                      |
| PNG           | `public/assets/generated/tile-door-open-side-v1-var-0.png`                                                          |
| entry         | `public/assets/generated/entries/tile-door-open-side-v1-var-0.json`                                                 |
| canvas        | 83 x 128                                                                                                            |
| opaque bounds | **69 x 114, aspect 0.605** (target band 0.45–0.85)                                                                  |
| sensors       | **7/7**                                                                                                             |
| judge         | design 5 / referenceStyle 5 / style 5 / brief 5 / readability 4 / presentation 5 — `passed: true`, not hard-blocked |
| run           | `generated/runs/tile-door-open-side-v1/2026-07-31T01-40-38-da630f38` (variant 0)                                    |
| check-in      | issue #2412, branch `assets/checkin-20260731-015341-e3a009`                                                         |
| art PR        | #2414 (art-only, auto-merge squash armed)                                                                           |

Family calibration: closed side-on 54x114 (0.474) → **open side-on 69x114 (0.605)** →
open face-on 90x114 (0.789). The new sprite sits cleanly between its siblings, so an E/W
door widens on opening without colliding with the face-on silhouette.

Runtime verified live (not inferred) at
`http://localhost:15281/lab.html?lab=ai-runner&scenario=floor1-default`:
`window.__floor1Debug.hasTexture('tile-door-open-side-v1-var-0') === true`.

## Root cause of the previous 6 failed attempts (the reusable lesson)

The prior brief (`briefs/props/tile-door-sideon-open-v1.yaml`) described its subject almost
entirely **by negation** — "a stone jamb strip beside a flat dark void, and DO NOT draw an
arch / lintel / keystone / stone-on-both-sides / curved top". A near-featureless dark void
framed by stone has exactly one strong archetype in an image model's prior: an **archway**.
Every revision added more bans and never supplied a competing positive subject.

> **Negative prompting cannot delete an archetype. It can only fail to summon a competing
> one.** Fix archetype problems by _substituting a positive subject_, not by adding bans.

Putting the door leaf back in the picture — "a heavy door standing AJAR", a positive
archetype structurally incompatible with an archway — eliminated archways **16/16 on the
first attempt**. The generator was never the ceiling.

## Second finding: the brief's `size:` never reaches the model

`size:` is the **output** dimension after transparent-trim + resize. The closed sibling's
brief claims a "narrow 48x128 canvas" was its structural fix — **that claim is false** and
future sessions should not trust it.

What the model actually sees is the **sheet cell shape**: `nativeCanvas / cols` wide by
`nativeCanvas / rows` tall. The default 4x4 on 1024 gives **square 256x256 cells**, which is
why every earlier attempt produced square, head-on art regardless of prose.

Setting `generation.sheet: { rows: 2, cols: 4, nativeCanvas: 1024 }` gives **256x512
portrait cells** and moved delivered aspect from 0.805–0.891 straight into 0.539–0.688 in a
single revision. This is the load-bearing lever for any tall, narrow subject.

## Third finding: no gate in this pipeline measures viewing angle

Revision 1 scored **16/16 sensors and 5/5/5/5 judge on completely wrong-projection art**
(head-on stone frames indistinguishable from the face-on open door). There is no projection
sensor and no aspect-ratio sensor; available overrides are only `opaqueRatio`, `weapon`,
`edge`, `enemy`, `interiorHoles`, `anchor`. The VLM judge reliably catches _nameable
objects_ (it hard-blocked on a lintel twice) but cannot see projection.

**The agent/human eyeball at game scale is the only defense, and this trap has now caught
four separate sessions.** Aspect must be measured manually via `Image.getbbox()` — and note
the processed canvas aspect is not the opaque-box aspect (revision 3: 0.609 canvas vs 0.553
opaque).

## Judgment call the maintainer may want to overrule

Revisions 2 and 3 were hard-blocked by the judge for drawing a flat stone lintel, which my
own brief banned. In revision 4 I concluded **the ban was the bug**: the maintainer's art
contract requires only side-on projection, portrait aspect 0.45–0.85 with transparent L/R
margins, family consistency, and a clear open/walkable read — it never mentions lintels, and
both face-on siblings are full stone surrounds. The ban was inherited unexamined from the
archway-phobic dead-end lineage.

This was a **brief correction, not a gate relaxation**: no sensor bound was loosened and the
judge's `<3` hard-block threshold is untouched. Flagged here so it can be cleanly reversed.

## Systems touched

- `briefs/props/tile-door-open-side-v1.yaml` — **new**, working brief (revision 4); header
  documents both dead ends and all four revisions with measured evidence.
- `briefs/tiles/tile-door-open-side-v1.yaml` — **deleted** (retired full-bleed
  rotate-by-renderer contract; never generated).
- `public/assets/generated/tile-door-open-side-v1-var-0.png` + `entries/*.json` — new
  approved asset (shipped in art PR #2414).
- No engine/gameplay code touched. `src/engine/sprites/door-visuals.ts` already declared
  `openVertical: 'tile-door-open-side-v1-var-0'`, so **no wiring work was required** — the
  brief simply had to carry that exact name.

## Apples

**1 apple** — pure art (brief → generate → approve → check-in → asset PR), review-ledger
exempt, no code diff.

## Follow-ups

- `briefs/props/tile-door-sideon-open-v1.yaml` still carries the disproven "generator
  capability ceiling" conclusion. Delete or mark superseded.
- Consider an **aspect-ratio sensor** (`sensors.aspect: { min, max }` over opaque bounds).
  It is cheap, deterministic, and would have caught revision 1's wrong-projection art that
  passed every existing gate at full marks.
- All four door sprites carry ~1.6–3.4% teal pixels where the sheet background bleeds into
  the soft grounding shadow. The new sprite (2.3%) sits _between_ the two shipped entries
  (1.63% and 3.39%), so it is a family-wide post-processing characteristic, not a
  regression — but a harder background key would clean up the whole family.
