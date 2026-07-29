# Handoff — Recalibrate blood-footprint spacing to the `rhea-vale-v1` player sprite

**Date:** 2026-07-28 · **Persona:** VFX/Gameplay · **Apples:** 2🍎 est → 2🍎 actual
**Branch:** `nalfeo-miniature-potato` · **Slug:** `blood-footprint-spacing`

## Systems touched

vfx

## What & why

Commit `9c8075baa` (#2254) swapped the player sprite from the Kenney Tiny
Dungeon knight (16 px @ `kenneyScale 1.6` → **3.2 ft** drawn) to the generated
`rhea-vale-v1` (64 px @ `scale 0.72` → **5.22 ft** drawn content). The
blood-footprint tuning constants were calibrated against the 3.2 ft sprite and
never followed.

The result was a hard geometric defect, not just a taste issue: stride spacing
was **0.42 ft** while a single print was **0.52–0.64 ft** long, so consecutive
prints physically overlapped and the trail rendered as one continuous red
streak instead of discrete footprints.

Measured before-state through the real visual pipeline
(`src/engine/sim/simulation-step.ts`): print #2's heel started at `x=0.65`
while print #1's toe still reached `x=1.18` — a **0.53 ft overlap**.

## The fix

Gait-calibrated retune of `src/shared/blood-surfaces.ts` only. `PlayerTrailVfx`
is a pure `ftToPx` passthrough, so **no renderer change was needed**.

| Group                           | Factor   | Rationale                                           |
| ------------------------------- | -------- | --------------------------------------------------- |
| Print geometry (all 9 fields)   | ×1.63    | exact drawn-height ratio 5.22 / 3.2                 |
| Stride (`..._EMIT_DISTANCE_FT`) | 0.42→2.1 | 0.41 × height — a real 5.2 ft-human walking step    |
| Lateral offset                  | ×2.6     | ties the L/R track to the sprite's wide boot stance |
| `MAX_..._EMITS_PER_FRAME`       | 24→5     | holds the teleport-snap threshold at ~10.5 ft       |

Sprite measurement used for calibration (1 sprite px = 0.72/8 = 0.09 ft):
drawn bbox 45×58 px → 4.05 × 5.22 ft; boots span 1.17 ft (left) and 0.90 ft
(right), centres **2.12 ft** apart.

## Observe before / after (real pipeline, not a lab)

Walked the player 21 ft due east through `src/engine/sim/simulation-step.ts`:

- **Before:** prints overlapped by 0.53 ft (recorded as a failing assertion).
- **After:** 9 discrete prints, alternating L/R, **1.08–1.25 ft of clean floor
  between** consecutive prints; along-path spacing 2.03–2.18 ft; print length
  0.91–0.98 ft; track width 0.895 ft (~42% of the sprite's 2.12 ft boot stance).

## Regression gates added

- `tests/unit/blood-surfaces.test.ts` → new `describe('player-sprite calibration')`,
  200-sample deterministic gate: **spacing ≥ 2× longest unsmeared print**, print
  length in `[0.85, 1.05]` ft, aspect ratio > 1.8, L/R track clears half-widths.
- `tests/integration/bloody-footprint-pipeline.test.ts` → real-pipeline
  `walkStraightLineTrail()` asserting non-overlap and L/R alternation.

## Notable decisions

- **`MAX_BLOODY_FOOTPRINT_EMITS_PER_FRAME` is dual-purpose.** It also defines
  `MAX_CONTINUOUS_FOOTPRINT_GAP_FT` in `bloodyFootprintSystem.ts` (the
  teleport-detection threshold). It had to move **inversely** with the stride
  (24 → 5) to hold that threshold near 10 ft. At 60 fps / ~10 ft/s the player
  travels ~0.167 ft per frame, so a cap of 5 is never a practical constraint.
- **The hard gate deliberately excludes smeared prints.** `smearFactor` is only
  non-zero when the player covers more than a full stride in one frame; blurring
  together at speed is intended. The unit gate samples at
  `strideDistanceFt = BLOODY_FOOTPRINT_EMIT_DISTANCE_FT` so `smearFactor = 0`.
- **`MAX_BLOODY_FOOTPRINTS = 160` left unchanged.** With a 5× longer stride and
  a 5 s lifetime only ~24 prints accumulate, so the cap is now heavily
  oversized — but lowering it is a behaviour change with no benefit.
- **Test-side `Math.hypot` accommodation.** `Math.hypot(2.1, 0)` returns
  `2.0999999999999996`, which is `< 2.1`, so a test moving the player _exactly_
  one stride emits zero prints. All four consumer tests now derive their walk
  from `STEP_FT = BLOODY_FOOTPRINT_EMIT_DISTANCE_FT * 1.05` rather than
  hardcoded distances, so they won't silently break on a future retune. The
  production guard was intentionally left alone.

## Validation

`verify:fast` ✅ · unit + ecs (18 tests) ✅ · integration (3 tests) ✅ ·
e2e `bloody-footprints-main-scene` ✅ · headless ✅.

`npm run scope` could **not** classify this change — it reported
`local-scope: not a git work tree — forcing full-suite (all-false)` (the known
Windows/WSL `bash` interop quirk in AGENTS.md), so heavy validation was run
rather than skipped.
