# Welcome-room floor decals: tile → prop regeneration

**Date:** 2026-07-25
**Agent:** Asset Forge (Graphics Designer persona)
**Branch:** `nalfeo-jubilant-tribble`
**Apples:** 3🍎 (art-only regeneration + a 4-line `set-pieces.json` id retarget; no engine change)

## What and why

The nine `welcome-room` floor props were briefed and generated as **opaque, seamless,
edge-to-edge repeating carpet tiles** (commit `38dc3ab17`). But `set-pieces.json` places
them as lone 1×1 props scattered on an already-painted continuous carpet floor. They are
**decals, not tiles** — so each one rendered as a hard-edged square patch dropped on the
carpet.

Baseline measurement of the four checked-in PNGs confirmed it mechanically:
`alpha0 = 0.0%`, `opaque = 100.0%`, `borderRing1px = 1020` (every canvas-edge pixel opaque),
`raggedness = 0.016`.

## Root cause (the important finding)

**The defect was the brief `type`, not the brief prose.** `scripts/sprites/build-prompt.ts`
hardcodes tile-specific prompt blocks at L232/254/313/371/455 that demand _"fill it
edge-to-edge"_, _"make edges tile seamlessly"_, _"do not center a floating icon"_ and
_"no transparent padding and no subject margin"_; L414 also suppresses sheet gutters for
tiles. No amount of brief wording can beat that scaffolding.

Switching all four briefs to `type: prop` (and `git mv`-ing them to `briefs/props/`) flips
every one of those: transparent-background prompt, 10% margin, gutters, and it **activates**
the `opaque-ratio` and `opaque-bbox-fits` sensors that are effectively inert on a full-canvas
tile. The user's acceptance criteria became natively enforced instead of unenforced.

## Second finding: prompt-based colour control does not work

Three escalating rounds of explicit hex ramps, luma floors and banned-colour lists moved the
output's mean luma by ~nothing (75–114 against a carpet of 175). The only lever that worked
was **post-process palette quantization**: a new `data/palettes/welcome-room-carpet.json`
(7-step ramp, luma 142–206, centred on the carpet's `#eaa56c`) plus
`postprocessing.paletteMode: strict`. `quantizeToPalette` snaps each opaque pixel to the
nearest ramp entry; because the mapping is monotone in luma it preserves the mark's internal
tonal structure while compressing its contrast into the carpet band. This also turns on the
`palette-membership` sensor, so it **tightens** the gate rather than loosening it.

Note: `paletteMode: strict` resolves the palette from `data/palettes/<brief.palette.id>.json`,
**not** from `brief.palette.colors` (see `load-brief.ts` L143, L265-283).

## Results

| asset | old id   | new id   | alpha0 | coverage | outer-10% ring | border1px | raggedness |
| ----- | -------- | -------- | ------ | -------- | -------------- | --------- | ---------- |
| worn  | `-var-0` | `-var-3` | 84.8%  | 15.2%    | 2              | 0         | 0.276      |
| stain | `-var-2` | `-var-1` | 78.8%  | 21.2%    | 15             | 0         | 0.214      |
| tape  | `-var-0` | `-var-1` | 73.3%  | 26.7%    | 10             | 0         | 0.200      |
| seam  | `-var-0` | `-var-9` | 84.4%  | 15.6%    | 8              | 0         | 0.303      |

All four ids changed, so the four `spriteId` values in `src/shared/data/set-pieces.json`
were retargeted (bare catalog ids — the `generated:` prefix renders a grey box with zero
console errors). Positions, footprints and `widthFt`/`heightFt` untouched.

`npm run setpiece:score -- welcome-room` → **10/11**, `floor-variety` passing, only the
known pre-existing `shell-integrity` failing. `npm run verify:fast` green.

## Residual defects (disclosed, not fixed)

- **Acceptance criterion "soft partial-alpha band" is unachievable in this pipeline.**
  `alphaBinary` (`sensors/common.ts` L97-119) is a universal, non-overridable sensor that
  fails any pixel whose alpha is not exactly 0 or 255. Every variant measures `partial = 0.0%`.
  I did not weaken it; I re-expressed feathering as the correct pixel-art idiom — dithered
  binary edges — measured by `raggedness` (a solid disc scores ≈0.10; these score 0.20–0.30).
- 2–15 stray speckle pixels sit in the outer-10% margin on left/right edges. **Zero** pixels
  touch the true canvas border, so nothing aligns to the tile grid, but it violates the
  literal criterion.
- `seam` reads roughly horizontal rather than the briefed shallow diagonal.
- `tape` no longer reads as tape — after the palette lock it is another wear smudge. At the
  in-game 16×16 render size this is arguably moot, but the identity is gone.
- `stain` is the weakest: a fairly flat slab, because palette quantization collapses
  uniformly-dark model output onto the single darkest ramp entry.
- At zoom the worn/tape/seam decals read as near-identical elongated diagonal scuffs; only
  `stain` is silhouette-distinct.

## Systems touched

- **Sprite briefs** — `briefs/tiles/welcome-room-floor-{worn,stain,tape,seam}.yaml` moved to
  `briefs/props/`, converted `type: tile` → `type: prop`, palette + strict quantization +
  tightened `opaqueRatio` (0.05–0.45 vs the prop default 0.10–0.65) and a documented
  `interiorHoles.maxPixels: 512` subject override.
- **Palettes** — new `data/palettes/welcome-room-carpet.json` (additive; only
  `kenney-roguelike.json` existed before).
- **Generated art** — four new PNGs in `public/assets/generated/`, plus
  `sprite-catalog.json` and `manifest.json` entries.
- **Set pieces** — four `spriteId` retargets in `src/shared/data/set-pieces.json`
  (`welcome-room` only; 9 prop refs).

## Follow-ups worth escalating

1. `type: tile` is a trap for any decal-like asset. Consider a `decal` type, or a lint that
   flags a `tile`-type brief whose only consumers are 1×1 `catalog` props.
2. Colour direction in briefs is inert. Document that palette quantization is the only
   working lever, so future waves don't burn rounds on prose.
