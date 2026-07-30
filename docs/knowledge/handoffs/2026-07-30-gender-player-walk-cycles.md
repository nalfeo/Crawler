# Gender-matched player walk-cycle sheets

## Systems touched: sprite-pipeline

## Summary

Replaced the single 3-frame `rhea-vale-v1-var-0-walk` player walk strip with
**three** gender-matched 4-frame walk-cycle sheets — `player-walk-cycle-female`,
`player-walk-cycle-male`, `player-walk-cycle-other` — selected at runtime from
`world.playerGender`. Each sheet is a single-row, 4-frame, 256×256-per-frame
strip (contact-L → passing-L → contact-R → passing-R), 8fps looping, generated
via the `frameSequence` sprite pipeline and approved through
`npm run sprites:approve -- --sequence` with zero sensor-threshold relaxation.

Originally stacked on `nalfeo-bookish-eureka` (PR #2321). That base merged to
`main` mid-session, and `main` independently gained two overlapping pieces of
concurrent work (see "Post-hoc rebase reconciliation" below). The branch was
rebased cleanly onto `origin/main` after PR #2321 merged; it is no longer
stacked on an unmerged branch.

## What shipped

- **Three approved 4-frame walk-cycle sheets** (`briefs/characters/player-walk-cycle-{female,male,other}.yaml`
  - their generated PNGs/shards at `public/assets/generated/entries/player-walk-cycle-{female,male,other}.json`).
    All pass `frame-coherence` and per-frame sensors (including the
    `center-of-mass` anchor override and `interiorHoles.maxPixels: 64` override
    inherited from the original `player-walk-cycle.yaml` brief) with **zero
    threshold relaxation**.
- **Native-canvas workaround**: Azure `gpt-image-1` only emits a square
  `1024×1024`. A straight 4×1 request at `nativeCanvas: 1024` would give
  1024×256 cells at 4:1 aspect, which the model consistently framed badly
  (bodies too small / cut at cell edges). Switched all three briefs to
  generate as a **2×2 native layout** (four 512×512 cells) and re-pack to the
  final single-row 4×256×256 strip in postprocess — this is the standard
  content-aware slice → normalize → re-pack path (see next bullet), not a new
  one-off script. The rationale is recorded as a comment in each brief's
  `frameSequence` block so a future regeneration doesn't regress to the
  degenerate 4:1 layout.
- **Fixed-grid slicer removed** (`scripts/sprites/slice-sheet.ts` +
  `brief-schema.ts` + `postprocess-modules.ts` + `build-prompt.ts` +
  `size-variants.ts` + their tests). There is now exactly **one** way to slice
  a generated sheet: the content-aware slicer. This was flagged mid-session as
  a real defect class (the fixed-grid path was cutting off the first/last
  frame on non-uniform layouts) and the removal was tracked as its own
  follow-up issue (#2336, closed) before being folded into this branch.
- **Gender-based texture resolution** — `src/engine/PhaserBridge.ts`:
  `resolveGeneratedTexture` gained a `variantsByAppearanceKey`-style lookup
  keyed by `world.playerGender` (schema documented in
  `docs/knowledge/adr/0059-gender-player-walk-cycle-variant-selection.md`).
  `'player'` remains deliberately absent from `GENERATED_BRIEF_BY_TYPE`, so the
  enemy-registry fast path always misses for the player and the new
  variant-lookup path is reached.
- **Silent-failure fix**: `warnGeneratedTextureUnresolved` now logs the
  **effective/resolved** variant descriptor (not just the top-level default),
  so a broken male/other entry logs its own keys instead of silently falling
  through to the female defaults in the log line. This closes the exact class
  of silent failure that let the original Rhea-Vale regression (PR #2321)
  ship undetected.
- **Player-visual reconcile fix**: the player's cached visual (Image vs.
  Sprite) is now re-checked every sync against the gender-resolved preferred
  texture, mirroring the existing enemy late-load reconcile. If the player was
  first created via the Kenney-fallback `Image` path (texture not yet loaded)
  and the gender-resolved animated texture later becomes available, the stale
  `Image` is destroyed and replaced in-place with an animated `Sprite` at the
  same position/scale. Covered by a new regression test in
  `tests/unit/phaser-bridge.test.ts` (round-1 multi-model review flagged this
  path as untested; fixed and re-confirmed clean in round 2 — see Review
  ledger below).
- **`entity-sprite-mapping-art-wiring.test.ts`** extended: the single
  `rhea-vale-v1` pin is now three gender-keyed assertions (female/male/other),
  each asserting its own pinned key + animation descriptor.
  **`phaser-bridge.test.ts`** and **`player-walk-animation.test.ts`** updated
  for the new texture keys.
- **Movement lab** (`src/labs/movement-lab/index.ts`): stale placeholder
  texture key/frame config updated to match the real shipped
  `player-walk-cycle-female` manifest entry (256×256, 4 frames, 8fps) so the
  lab doesn't silently drift from production.
- **Art defect fixes mid-session** (all re-generated, re-approved, zero
  threshold relaxation):
  - Female sheet initially failed the `interiorHoles` sensor on legitimate
    mid-stride leg-gap negative space — root-caused and fixed at the pixel
    level (not a threshold change).
  - Facing-direction defect: one frame in both the male and female sheets was
    facing the wrong direction, which would have produced a visibly "wonky"
    walk cycle. Added explicit "CRITICAL FACING DIRECTION" guidance to all
    three brief YAMLs and regenerated.
  - Detail-parity defect: the `other` sheet initially rendered at noticeably
    lower detail/resolution than female/male. Added "CRITICAL DETAIL PARITY"
    guidance and regenerated; now visually matches.

## Hard success gate — verified

1. ✅ All three sheets approved via `sprites:approve -- --sequence`, passing
   `frame-coherence.ts` and per-frame sensors, zero relaxation.
2. ✅ `tests/unit/player-gender-sprite-resolution.test.ts` — deterministic unit
   test asserting each of the three `world.playerGender` values resolves to
   its own distinct, shipped 4-frame animated manifest entry.
3. ✅ Real-game observation in `npm run dev` (NOT a lab): played the intro
   picking She/Her, He/Him, and the third option, three separate playthroughs.
   Confirmed three visually distinct sprites (ponytail / short-hair-broader-build
   / short-spiky-hair), correct empty-hands neutral pose, correct horizontal
   flip on movement direction, and a stable floor line with no vertical bob
   across the cycle for all three. Idle (frame 0) snap-to-rest confirmed for
   female and male. Scale was verified empirically against the drawn
   on-screen size (player consistently reads at the same on-screen footprint
   as before the change, next to the WELCOME sign and floor tiles), not just
   via arithmetic — the postprocess crop is bbox-driven, so the
   figure-to-frame ratio at 256×256 was independently confirmed to still
   render at the pre-existing on-screen size. See "Post-hoc rebase
   reconciliation" below for the corrected exact scale value.

## Post-hoc rebase reconciliation (after this handoff was first drafted)

The intended base (`nalfeo-bookish-eureka` / PR #2321) merged to `main` while
this session was still in flight, **and** `main` independently gained two
overlapping pieces of concurrent work:

1. Another session removed the fixed-grid `frameSequence` slicer as a
   superset generalization (arbitrary `rows×cols`, not just the single-row
   removal this session had already done narrowly). Rebased onto that
   superset and dropped this session's narrower reimplementation entirely —
   no functional loss, `scripts/sprites/slice-sheet.ts` /
   `brief-schema.ts` + tests now match `main`'s version.
2. Another session wired the **old**, now-unused single-gender
   `player-walk-cycle` shard (64×64, `scale: 0.71875`) to the player render
   kind, along with a new deterministic guard,
   `tests/unit/player-npc-scale-parity.test.ts`, asserting exact
   `toBeCloseTo(_, 5)` scale/height parity between the player and welcome-room
   NPC height (`46px` at `PIXELS_PER_FOOT = 8`, `heightFt = 5.75`). Rebasing
   surfaced that this session's originally-shipped scale (`0.18`, a rounded
   approximation) would have **failed that 5-decimal-precision guard** once
   merged. **Corrected the scale to the exact value, `46/256 = 0.1796875`**,
   in all four places in `entity-sprite-mappings.json` (top-level default +
   all three gender variants) and in the corresponding test assertions. Also
   repointed `player-npc-scale-parity.test.ts`'s import from the old
   `player-walk-cycle.json` shard to `player-walk-cycle-female.json` (the new
   default/female variant) since the old shard is no longer the player's
   pinned texture. All tests pass at the corrected value; `verify:fast` and
   `verify:pr-prereqs` re-run clean post-rebase.

The rebase was resolved commit-by-commit with genuine conflict review (not
blind `--ours`/`--theirs`) in every file except the slicer, where `--ours`
(main's superset) was taken deliberately per point 1 above.

## Known risk — flagged for future work (NOT gated)

**Cross-sheet proportion consistency is a soft, ungated guarantee.**
`checkFrameCoherence` only compares frames _within_ one sheet — there is no
deterministic check that female/male/other share identical build, height, or
silhouette scale across sheets. Mitigated this session by generating all three
from the same base-body reference and eyeballing proportion match at approval
time (confirmed via real-game observation), but this is **not enforced by any
gate**. Whoever builds the future equipment-overlay system (which will need
all three player rigs to align pixel-for-pixel so gear art can be shared)
should treat this as a real risk and consider adding a cross-sheet
proportion/anchor-alignment sensor before that work begins.

## Review ledger

`docs/knowledge/review-ledgers/2026-07-30-gender-player-walk-cycles.review-ledger.json`
— 4🍎 tier, all three required stages complete and valid:

- `plan_review`: adversarial (gpt-5.4), 3 alternatives considered, convergent,
  5/5 concerns resolved.
- `code_review`: round 1 (claude-sonnet-4.6), clean.
- `multi_model_review`: round 1 (sonnet + codex + gpt-5.4 security) found 1
  valid finding (untested Image→Sprite reconcile path), adjudicated by
  gpt-5.4, fix delegated and applied; round 2 (sonnet + codex) confirmed
  clean.

## Apple estimate

Estimated 4🍎. Actual: 4🍎 (art-defect iteration and the fixed-grid-slicer
removal added real time but stayed within the same complexity tier — no
architectural surprises; `apples:record` run at handoff).

## Follow-ups filed

- #2336 (closed) — remove the fixed-grid slicer, standardize on the
  content-aware slicer as the one way to slice.

## Old shard cleanup

The now-fully-unreferenced `rhea-vale-v1-var-0-walk` shard (the original
3-frame player walk strip this session replaced) was **deleted**:
`public/assets/generated/entries/rhea-vale-v1-var-0-walk.json`. It was
already a dangling shard before this session's cleanup pass — its
`assetPath` pointed at `generated/rhea-vale-v1-var-0-walk.png`, which a prior
concurrent PR (`#2322`, "wire real player walk art and lock player/NPC scale
parity") had already deleted from disk as orphaned, but the JSON shard itself
was left behind. Removed for real this time; nothing in `src/` or the
manifest-consuming code referenced it after this session's wiring change.

The **static** `rhea-vale-v1-var-0` entry (a non-animated portrait, the
`sourceRun` this walk shard was originally `derived-from/`) was **left
untouched** — confirmed no walk-cycle work in this session modified
`public/assets/generated/entries/rhea-vale-v1-var-0.json` or its PNG.
