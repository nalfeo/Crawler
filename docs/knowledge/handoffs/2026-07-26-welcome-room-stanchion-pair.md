# Handoff — welcome-room-stanchion-pair (Asset Forge, single-prop regeneration)

Date: 2026-07-26
Persona: Graphics Designer / Asset Forge
Apples: **2🍎** — pure art (brief + palette + generate + judge + approve + check-in

- art-only PR). No engine, gameplay, wiring or set-piece code was touched, so this
  is review-ledger exempt (art-only fast lane).

## What shipped

`welcome-room-stanchion-pair-var-4` — a queue barrier: two upright stanchion
posts with weighted elliptical bases, ball finials, and a deep muted-crimson
velvet rope swagging in a catenary between the finials.

- Run: `generated/runs/welcome-room-stanchion-pair/2026-07-27T04-37-48-935a355a`
- Sensors **7/7**, VLM judge **4/5/5/5** (design_language / reference_style_match /
  brief_match / readability), `combinedPassed` on all 6 sliced variants.
- Approved variant 4, checked in (issue #2091), batched into art-only PR **#2093**.
- `npm run check:tile-mattes` clean (387 sprites, no magenta matte).

### Measured, shipped geometry (do NOT declare the briefed numbers)

| Thing                    | Value                        |
| ------------------------ | ---------------------------- |
| Shipped PNG canvas       | **128 x 86**                 |
| **Measured drawn box**   | **114 x 72 px**              |
| Shipped drawn aspect     | **1.583 : 1**                |
| Briefed aspect (6 x 3.4) | 1.765 : 1                    |
| Convergence              | **No — ~10% short of brief** |

Truthful world-feet derivations from the SHIPPED aspect, for whoever places this:

- Keep the briefed **6 ft width** → height must be declared **3.79 ft**.
- Keep the briefed **3.4 ft height** → width must be declared **5.38 ft**.

Declaring `6 x 3.4` against art that is `1.583:1` is exactly the bug that makes
contain-fit's `Math.min` silently discard an axis. Pick one of the two pairs above.

## The regeneration this replaces

`welcome-room-velvet-rope-var-2` (canvas 96x67, drawn box 86x57, aspect 1.509) was
rejected twice by the visual judge with the same words — "reads as a hose lying on
the floor". Its posts occupied under half the drawn height, so the silhouette was
dominated by a horizontal cord. The new sprite inverts that: the posts + finials
are the dominant vertical mass, the bases are the widest/heaviest elements, and the
rope is a secondary detail hanging clear of the floor.

## What made it work first round (three levers, all applied together)

1. **Natively landscape cells.** `sizeVariant: wide` → size 128x64 and a 4-row x
   2-col sheet, i.e. **512x256** source cells. The model composed into a wide frame
   instead of fitting a wide object into a square one. This was the previously
   untried lever and it is the one worth reusing for any wide prop.
2. **Width-locked resize by construction.** 128x64 satisfies `w >= 2h`, so
   `resizeSpriteStrategy` returns `'width'`: final PNG width is locked at 128 and
   the height follows the drawn subject. Cannot letterbox, so `anchor-*` cannot be
   tripped by padding and the prop cannot render short.
3. **ONE axis in source pixels.** The brief asked for "roughly 380 of the 512
   horizontal source pixels" and explicitly told the model to let the height be
   whatever the object honestly needs. Confirms the earlier lesson: stating both
   axes yields the width and a wrong height.

Also: `paletteMode: strict` against a purpose-built 16-step iron / brass /
muted-crimson ramp (`data/palettes/welcome-room-stanchion.json`). Prose colour
direction does not steer this model; quantization does, and the lock also
ACTIVATES the palette-membership sensor, so it tightens the gate.

`sizeVariant: tall` was NOT used (documented as actively harmful on props).

## One sensor contract choice, disclosed honestly

`sensors.anchor.mode: center-of-mass`. A queue barrier has TWO ground contacts with
an intentional gap between them, so its bottom-centre is empty air; the grip-derived
anchor would pick a base whose midpoint is ~1/4 of the frame off-centre and fail
every variant regardless of art quality. Centre-of-mass is the correct contract for
a two-footed object (same reasoning as `welcome-room-cable-coil`). **No threshold
was relaxed** — every other sensor kept its default, including `interiorHoles: 0`.

## Verification

- All 6 variants are a **single connected component** — no floating islands or
  detached fragments (checked explicitly, not just via the edge sensor).
- Eyeballed at 5x on a dark floor and downsampled to 48x32 (true game scale): still
  reads unmistakably as a standing barrier.
- `git ls-tree origin/assets/batch-20260727-044648` confirms the PNG is **tracked**
  on the PR branch alongside the manifest and catalog entries that reference it —
  the untracked-PNG silent break did not recur.
- Local working tree: `manifest.json` / `sprite-catalog.json` were reverted to HEAD
  after check-in so this branch never carries a catalog entry pointing at an
  untracked file. The canonical copies live on PR #2093.
- `npm run verify:fast` passed.

## Systems touched

- `briefs/props/welcome-room-stanchion-pair.yaml` — new brief (on PR #2093).
- `data/palettes/welcome-room-stanchion.json` — new 16-step locked ramp (PR #2093).
- `public/assets/generated/welcome-room-stanchion-pair-var-4.png` +
  `public/assets/generated/manifest.json` + `src/shared/data/sprite-catalog.json`
  — one approved variant registered (PR #2093).
- No engine, gameplay, wiring or set-piece placement code touched.

## Follow-ups

1. **PR #2093 is open, non-draft, and NOT auto-merge-armed** (the request asked for
   "ready for review"). Arm with `gh pr merge 2093 --auto --squash` when happy.
2. **Wiring is not done.** Nothing renders this until the `welcome-room` set piece
   points a `custom` ref at `welcome-room-stanchion-pair-var-4` and retires
   `welcome-room-velvet-rope-var-2`. That is a code PR: full gates,
   `check:wired-systems`, apple-scaled review harness + ledger. Use the measured
   feet above, not the briefed ones.
3. The barrier's two posts are deliberately different metals (dark iron left,
   brass right) in every variant. It reads as character, but if the room wants a
   matched pair that is a regeneration, not a paint-over.
