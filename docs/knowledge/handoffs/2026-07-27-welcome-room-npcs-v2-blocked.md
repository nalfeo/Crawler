# 2026-07-27 — Welcome-room NPCs v2 (goon + merchant): blocked on `anchor-derivable`

**Status: BLOCKED, escalated to the human. No art approved, checked in, or PR'd.**
**Apples: 3🍎** (pure art wave; review-ledger exempt — no code touched).

## Scope

Regenerate two of the three Floor 1 `welcome-room` NPCs as `welcome-goon-v2` and
`sweaty-merchant-v2`, to replace `npc-welcome-goon-var-0` and
`npc-sweaty-merchant-var-0`. Quality bar: the accepted `spell-broker-v2-var-3`.

## What was produced

- `data/palettes/welcome-room-goon.json`, `data/palettes/welcome-room-merchant.json`
  — purpose-built 16-step strict ramps guaranteeing a mid-value garment mass plus
  one saturated accent per character. The palette-membership sensor passed every
  round, so the palette lock did its job.
- `briefs/characters/welcome-goon-v2.yaml`, `briefs/characters/sweaty-merchant-v2.yaml`
  — nine iterations, each with rationale comments recording the failure it fixes.
- Nine generation rounds on the Azure sidecar (~$13.85 of judge spend).

## The blocker, with proof

`anchor-derivable` (`scripts/sprites/sensors/derive-anchor.ts`) scans bottom-up
for the first opaque row, splits it into contiguous opaque **runs**, and picks the
single run whose midpoint is nearest `floor(width/2)`. **It never spans two runs.**

A standing human in 3/4 view has two boots, so its bottom row is two runs. Measured
on the round-9 merchant variants (`files/anchor-runs.cjs`):

| variant | bottom-row runs      | sensor picks | offset  | if runs were fused |
| ------- | -------------------- | ------------ | ------- | ------------------ |
| 02      | `[21-26]`, `[37-43]` | 40           | +8 FAIL | **32 → offset 0**  |
| 06      | `[20-27]`, `[38-44]` | 23           | −9 FAIL | **32 → offset 0**  |
| 07      | `[21-27]`, `[39-45]` | 24           | −8 FAIL | **33 → offset 1**  |
| 10      | `[21-27]`, `[38-44]` | 24           | −8 FAIL | **32 → offset 0**  |
| 11      | `[20-26]`, `[39-44]` | 23           | −9 FAIL | **32 → offset 0**  |

The figures are **perfectly centred** — the two boots straddle x=32 symmetrically.
The composition is correct; the sensor's single-run selection is what rejects them.
Note the failures alternate sign (+8 / −9) purely by which boot run wins the tie.

This also explains the historical record: no character brief in this repo has ever
passed this sensor cleanly, and all three shipped welcome-room NPCs have alpha 0 at
their declared anchor (32,63) — the 2026-07-08 handoff records they were approved
by an unconditional human override.

## Why nine rounds and not two

Each lever that satisfies the sensor costs art quality, and vice versa:

| round      | lever                                          | sensor result               | judge                           |
| ---------- | ---------------------------------------------- | --------------------------- | ------------------------------- |
| 4 goon     | both hands on centred clipboard, feet together | **8/8, full pass (var 10)** | 3/4/3/3 weak — "squat and wide" |
| 4 merchant | (best art of the wave)                         | 7/8 anchor only             | **4/4/4/5**                     |
| 6 merchant | both hands on tray                             | **8/8 all variants**        | 2/2/1/2 — collapsed to 4 heads  |
| 7 goon     | **no jacket** (light polo is the torso)        | slicer artifact             | —                               |
| 8 goon     | + islanded-cell gutters                        | 7/8 interiorHoles           | **4/4/5/4 — best art**          |
| 9 goon     | + zero-holes clause                            | holes 39→0–4                | anchor broke, judge 2/3/2/2     |
| 9 merchant | fused-boot clause                              | 7/8 anchor only             | **4/4/4/5**                     |

The one genuine full-pipeline pass in the whole wave is **round 4 goon variant 10**
(8/8 sensors + judge pass, `combinedPassed: true`, real 40×58 figure). I rejected it
on the eyeball step: composited on a dark floor at true game scale it reads as a dark
blob, which is the maintainer's stated pass/fail criterion. Round 8 fixed exactly that
(dropping the jacket so the light polo is the dominant mass) and is the best art of
the wave, but trades back a sensor.

## What worked (keep these levers)

- **Dropping the jacket entirely** is what finally gave the goon value separation
  from a dark floor. "Light shirt under an open dark jacket" does not survive
  quantization at 64px — the dark mass wins. Light torso, dark legs.
- **Both hands on a centred prop** reliably centres the silhouette.
- **A narrow prop** is what lets the figure stay tall: a wide tray at chest height
  forces the model to shrink the figure to fit the cell, which is what produced
  every "four heads tall" result.
- **Explicit row-and-column gutter language** is required or the slicer returns
  vertical strips that then score as if they were sprites. Always measure the
  drawn box of a "passing" variant — an aspect near 0.26–0.34 means a strip, not
  a character.

## Decision needed from the maintainer

I did not loosen `centerToleranceX`, `bandRows`, the judge bar, or any threshold,
and I did not switch `anchor.mode` (explicitly forbidden for this scope). Options:

1. **Human override at approve time** — the precedent for all three existing
   welcome-room NPCs.
2. **`anchor.mode: center-of-mass`** for character briefs — a contract choice, not
   a relaxation (the stanchion-pair precedent), but forbidden for this scope
   without sign-off.
3. **Fix `deriveAnchor`** so grip mode spans the outer extent of the bottom-row
   runs rather than picking one. The data above says this would pass these sprites
   at offset 0–1. This is a code change and belongs in a code PR, not this art lane.

## Systems touched

- `data/palettes/` — two new locked ramps (new files only).
- `briefs/characters/` — two new briefs (new files only).
- `files/` — throwaway measurement tooling (`measure-box.cjs`, `anchor-runs.cjs`,
  `dark-floor-check.cjs`).
- **No engine, no catalog, no manifest, no `sprite-kind.ts`.** Nothing shipped.

## Wiring status

Wiring is **outstanding and owned by the parent session** —
`src/engine/phaser-bridge/sprite-kind.ts:346-347` still points at
`npc-welcome-goon-var-0` and `npc-sweaty-merchant-var-0`. I did not touch it.

Related trap, unchanged: the catalog still contains orphaned
`sweaty-merchant-v1-var-1` and `sweaty-merchant-v1-var-11` — approved in an earlier
wave and never wired to anything.
