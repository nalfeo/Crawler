# Session Handoff: Set Piece Designer agent + deterministic composition gate

## Date

2026-07-25

## Persona

`Producer → Set Designer` (new persona introduced by this session)

## Systems touched

agent-personas, mapgen, sprite-workflow

## Apples

3🍎 estimated, 4🍎 actual (`under` — under-estimated by 1; the tooling-only 3🍎 cap
stopped applying once the session began changing shipped game data
(`src/shared/data/set-pieces.json`) and commissioning two art waves; see
`docs/knowledge/metrics/apples/2026-07-25-set-piece-designer.json`)

## What Was Done

Built the **Set Piece Designer** agent: a persona, an agent definition, five skills, a
deterministic composition gate, and a style lookbook — then used the whole thing
end-to-end on one real room to prove it works.

The presenting complaint was that set pieces "feel like AI slop". Diagnosis first:
**12 of the 13 authored set pieces are uniformly-tiled floor boxes carrying 3–5 non-floor
props (~5% occupancy), and none of them declare `widthFt`/`heightFt` on any prop.** Only
`welcome-room` declared real-world feet. That second fact is the mechanical root cause of
"props don't feel like they fit": `SET_PIECE_TILE_SIZE = 16`px and `PIXELS_PER_FOOT = 8`,
so 1 tile = 2 feet, and a `SpriteLayer` without a feet box is stretched to the tile grid
instead of contain-fit inside a real-world footprint. Sizing was never authored, so
nothing could look correctly sized.

Delivered:

- **`scripts/agent/set-piece/composition-score.ts`** — a pure deterministic scorer with
  **11 checks** (no I/O, no RNG, no clock), plus a CLI (`npm run setpiece:score`) with
  `--json` / `--fail-on-violation`. 29 unit tests.
- **`docs/knowledge/game-design/set-piece-lookbook.md`** — two supplied reference
  lookbooks distilled into five principles, a palette-by-room-job table, and a
  retro-vs-modern axis. Carries an explicit attribution caveat (see Lessons).
- **`docs/agent-os/personas/set-designer.md`** + routing row, **`.github/agents/set-piece-designer.agent.md`**,
  and five skills: `set-piece-blockout`, `prop-inventory`, `prop-commission`,
  `set-piece-dress`, `set-piece-review`.
- A set-piece scenario appended to `.github/skills/visual-review/SKILL.md` (the advisory
  second gate — the deterministic scorer is the hard one; no LLM-as-judge in CI).
- **`welcome-room` redressed** from 5/11 to **10/11** (41 props), and its 14 outstanding
  custom art requests generated, judged, approved, checked in and wired via Asset Forge.

**Observed in the set-piece lab (`/lab.html?lab=set-piece-lab&piece=welcome-room`) —
before: 3–5 grey placeholder props on a bare orange floor, no real-world sizing; after:
41 correctly-scaled props rendering as real generated pixel art, mass pushed to the walls,
reception desk reading as a clear focal point.** Two intermediate renders caught defects
that every deterministic check had passed — see Mistakes.

`welcome-room` intentionally ships at **10/11**, failing only `shell-integrity` (no wall
ring, no door). That check was added _specifically_ to flag the migration that the child
session "Prefab set-piece rooms" is landing; it is a deliberate signal, not an unfinished
gate.

## Key Decisions Made

- **Two gates, only one of them blocking.** A deterministic scorer is the hard CI gate;
  the subjective visual judge is advisory. This follows the existing "no LLM-as-judge in
  CI" rule, and the session repeatedly demonstrated why _both_ are needed: a green
  deterministic score is necessary but nowhere near sufficient.
- **The room art contract.** Palette subset, light direction, shadow convention and
  wear/era are decided once at blockout and injected verbatim into every brief in the
  batch. This is what makes separately-generated props cohere.
- **`floor` and `wall` are structure, not dressing.** They are excluded from the
  `occupancy` and `perimeter` checks. Counting a uniformly tiled floor as "occupancy"
  would have scored the worst rooms highest — a self-inflicted design flaw caught during
  implementation and now locked in by a regression test.
- **Set pieces own their shell.** `shell-integrity` requires a complete wall/door
  perimeter ring _and_ at least one door prop on that ring, on the principle that mapgen
  carves the room to the prefab footprint rather than the prefab being dropped into
  whatever mapgen made. The implementation of that carve is the child session's PR.
- **Walls and doors must be tile writes, never ECS entities.** `src/core/spawners/world-objects.ts:241`
  documents that set-piece props are render-only _on purpose_: allocating entity ids for
  dressing shifts ambient-mob/drop ids, perturbing collision-pair enumeration order and
  the global RNG, which breaks headless↔rendered determinism. This was passed to the
  child session as a non-negotiable and is worth restating in any future set-piece work.
- **Thresholds are v1 ballpark, deliberately.** The human's call was "tune later". They
  are calibrated against the 13 existing rooms, not against the reference lookbooks.

## What's Next / Blockers

- **Child session** `nalfeo-prefab-set-piece-rooms` (**PR #2000**, base `nalfeo-jubilant-tribble`)
  lands real walls/doors in mapgen as tile writes and migrates all 13 defs to pass
  `shell-integrity` — green on all 13 once it merges. Its gate is a zero-tolerance Floor 1
  reachability sweep (run `30153080406`,
  `project:sweep-results-viewer runId=30153080406`), 150/150 with 0 degradations locally.
  Reviewed and approved from this session against the three invariants that mattered:
  walls/doors stayed tile writes (no ECS entities), the `collision-pair-parity` golden
  re-baseline kept its non-vacuity + byte-identity + back-to-back stability assertions per
  ADR 0049, and the `carved` flag reads ground truth (`welcomeCarve.fitted`) rather than
  the `bounds == footprint` proxy that produced a false-green in round-2 review.
- **`floor-variety` needs a rethink, not just a retune.** See Mistakes — as written it
  actively rewards the worst-looking element in the room. Strong candidate: measure the
  _baked terrain floor_ rather than counting scattered decal props.
- **Archetype-scoped thresholds.** Boss dens are the documented density _exception_, and
  `wall-anchoring` (≥60% of large props touching the ring) would legitimately fail a boss
  den built around one monumental central object. The agent doc currently says escalate
  rather than edit `DEFAULT_THRESHOLDS`; that is a stopgap.
- **The other 12 rooms have not been redressed.** Only `welcome-room` has been taken
  through the loop. Every other room still scores in the low single digits.
- **Known residual defects in the welcome-room floor decals, accepted deliberately** (the
  squares problem they replaced is fixed and independently verified: alpha-0 went 0.0% →
  73–85%, opaque canvas-border pixels 1020 → **0** on all four):
  1. Literal soft alpha feathering is **impossible in this pipeline** — `alphaBinary`
     (`sensors/common.ts`) is a universal, non-overridable sensor that fails any pixel not
     exactly alpha 0 or 255. Softness is achieved as dithered binary edges instead. This
     sensor was _not_ weakened to accommodate the art (rule #11).
  2. 2–15 speckle pixels sit inside the outer-10% margin. None touch the true canvas
     border, so nothing grid-aligns, but it violates the brief's stated margin rule.
  3. `seam` generated roughly horizontal rather than the briefed shallow diagonal.
  4. `tape` no longer reads as tape after the palette lock — it is just another wear
     smudge. This costs a small piece of the reality-show staging conceit (production
     floor marks) and is the one worth revisiting.
  5. `stain` is the weakest of the four: a fairly flat slab, because strict quantization
     collapses uniformly-dark output onto the darkest ramp entry.
  6. Across the five floor sprites there are only three distinct silhouettes —
     worn/tape/seam all read as similar elongated diagonal scuffs at game scale.

## Retrospective

### Lessons Learned

- **A green gate is not a good room, and the gap is not small.** The first 9/9 redress
  looked visibly _worse_ than the 5/9 original. This is the single most important lesson
  of the session and is why the advisory visual gate exists at all.
- **Silent art failures are indistinguishable from load races.** Catalog ids carry a
  `generated:` prefix but set-piece `spriteId` must be the **bare** id; using the prefixed
  form renders grey boxes with **zero console errors**. Separately, props render as grey
  boxes for a second or two while textures load async. The two look identical. Always let
  the render settle before judging, and confirm refs against
  `public/assets/generated/manifest.json` (a keyed map under `entries`, keyed by
  `spriteName`) before concluding the art is broken.
- **Set-piece `custom` art refs do not auto-resolve on check-in.** `collectCustomArtRequests`
  counts `source: 'custom'` layers unconditionally; the refs must be rewritten to
  `catalog` by hand.
- **Schema constraint:** `x + width ≤ def.width` is validated, so a 1×1 prop cannot sit at
  `x = 9.1` in a 10-wide room. Use `offsetXFt`/`offsetYFt` for edge stagger, not
  fractional `x`/`y` on the far wall.
- **`anti-grid` is spacing-exact** — it only flags runs whose consecutive `sortBy` values
  differ by exactly 1. Any fractional offset defeats it. It is a much weaker check than it
  appears.
- **The lab is at `/lab.html?lab=<name>`, not `/?lab=...`.** `rg`/`ripgrep` is not on PATH.
- **Supplied reference lookbooks had unreliable attributions** — the second reused the same
  AI-study image under different game credits (plate 04 ≡ 12, 13 ≡ 14). Treat such
  documents as _visual specimens, not citations_; the synthesis is still valuable.
- **IRM-protected PDFs must not be worked around.** Two supplied files were Microsoft
  Information Protection encrypted; the correct move is to report the blocker and ask for
  an unprotected export.

### Mistakes Made

- **I let a check drive art that made the room worse — and only caught it by rendering.**
  `floor-variety` (≥3 distinct floor sprites, none >70%) was satisfied by nine scattered
  1-tile floor decals. On the render they read as loose sheets of paper lying on the
  carpet: the sloppiest thing in the room. Deleting them makes the room look better and
  drops the score to 9/11. **Early signal: any check that can be satisfied by _adding
  more objects_ will eventually be satisfied by adding bad ones.** A check with a floor
  and no ceiling, or one that counts instances rather than measuring an outcome, is
  suspect by construction.
- **I briefed four sprites for what they were called instead of how they were used, and
  burned two full generate/judge rounds on it.** All four `welcome-room-floor-*` briefs
  demanded opaque, seamless, edge-to-edge repeating carpet tiles — but the data places
  them as nine _isolated_ single tiles on a continuous floor. An opaque square dropped in
  isolation always reads as a square; colour-matching cannot fix it because the defect is
  the opacity and the 90° edge, not the hue. Both rejected rounds were spent critiquing
  hue, contrast and border artefacts — chasing symptoms while the premise was wrong.
  **Early signal: two rejection rounds that produce _different_ critiques of the same
  asset means the brief's premise is wrong, not its details.** Now encoded as a rule in
  `.github/skills/prop-commission/SKILL.md`.
- **My diagnosis of that was right, but my fix was wrong, and the difference matters more
  than the original mistake.** I rewrote the brief _prose_ to demand a transparent
  background, in block capitals, at length. It had no effect. The actual cause was the
  brief **`type`**: `build-prompt.ts` hardcodes `type: tile` blocks demanding "fill it
  edge-to-edge", "seamless in both axes" and "no transparent padding and no subject
  margin" — and, worse, leaves the `opaque-ratio` and `opaque-bbox-fits` sensors **inert**
  on a full-canvas image. No description text can outvote a hardcoded prompt block, and
  the two sensors that would have caught the defect were disabled _by the type field
  itself_. Moving the briefs to `type: prop` flipped both at once. **Early signal: if a
  stated requirement keeps being ignored no matter how emphatically it is restated, stop
  rewriting the request and go read what the pipeline actually assembles from it.** This
  is the same structural bug as the child session's `bounds == footprint` false-pass: a
  check sitting in a position where everyone assumes it is covering them, while being
  structurally incapable of failing.
- **Prompt-based colour control does not work with this image model.** Three rounds of
  explicit hex ramps, luma floors and banned-colour lists moved the mean luma by
  approximately nothing. What actually worked was a palette file
  (`data/palettes/welcome-room-carpet.json`) plus `paletteMode: strict`, which also
  _tightens_ the gate by activating `palette-membership`. Prefer palette constraints over
  prose for any colour requirement.
- **My first redress over-dressed the room to 63% occupancy** against a 22% floor, and
  used `welcome-room-shop-table` as a crate placeholder, which rendered as 8 mini
  shop-tables. Omitting `placeholder` entirely reads better than a wrong one.
- **I initially wrote `occupancy` and `perimeter` to count `floor` props**, which would
  have scored the sloppiest rooms highest. Caught during implementation, not by a test —
  the regression test came after.
- **`checkStacking` originally counted props-per-tile**, so composite multi-layer props
  scored zero nesting. Found only by running the scorer on real data and disbelieving the
  result. Worth repeating: _run a new metric against real data and interrogate any score
  that looks wrong, before trusting it enough to author against._
- **I told the child session I would warn it before committing art, then the background
  Asset Forge agent committed autonomously before I could.** No damage — I notified
  immediately with the SHA and the conflict surface — but delegating work that touches a
  file another session is actively migrating needs the coordination constraint stated _in
  the sub-agent's brief_, not just held in my own plan.

### Opportunities for Future Improvement

- **Promote the two render-only defect classes into deterministic checks.** Both the
  `generated:`-prefix grey-box failure and the opaque-decal-on-continuous-floor failure
  are mechanically detectable: the former by validating every `catalog` `spriteId` against
  the manifest at test time, the latter by asserting that a `floor`-kind prop placed on a
  minority of tiles has a mostly-transparent alpha channel with a clear border ring. Both
  currently rely on a human or agent looking at a screenshot.
- **Add a ceiling to `occupancy`.** It has a floor of 22% and nothing stops 63%.
- **Archetype-scoped thresholds** (`boss-den`, `settlement`, `corridor-scene`) rather than
  one `DEFAULT_THRESHOLDS` block with an escalation note.
- **Redress the remaining 12 rooms** — the tooling now exists and the loop is proven, but
  each room still needs its own art wave, which is the expensive part.
- **Consider whether `anti-grid` earns its place** given how trivially a fractional offset
  defeats it.
- **Add "can this gate actually fail?" tests.** This session hit the same structural bug
  twice from opposite directions: the sprite pipeline's `opaque-ratio` /
  `opaque-bbox-fits` sensors were inert because of the brief `type`, and the child
  session's reachability gate derived `carved` from a proxy that a coincidentally-sized
  room satisfies. In both cases a check that everyone relied on was structurally incapable
  of failing. Any gate whose active inputs are selected by a config knob (a brief `type`,
  a scenario flag) deserves an explicit negative test proving it rejects a known-bad
  input.
- **Audit the other brief types for the same inert-sensor problem.** `type: tile` silently
  disabling two sensors was not documented anywhere; it is unlikely to be the only case.
