# Handoff — welcome-room living-area props (Asset Forge wave)

Date: 2026-07-27
Persona: Graphics Designer / Asset Forge
Apples: ~4🍎 (pure art — brief + generate + judge + approve + check-in + asset PR;
no wiring, no engine change, so review-ledger exempt).

## What shipped

Five of six requested living-area props were generated on the Azure sidecar,
passed all 7 deterministic sensors AND the VLM judge, were approved, checked in
(issue #2082) and batched into art-only PR **#2084** (auto-merge armed, squash).

| Brief                       | Variant | Shipped px | Intended ft | Judge (DL/RSM/BM/RD) |
| --------------------------- | ------- | ---------- | ----------- | -------------------- |
| `welcome-room-chore-rota`   | var-2   | 96x80      | 3 x 2.5     | 4/4/5/5              |
| `welcome-room-laundry-line` | var-0   | 128x64     | 6 x 3       | 4/4/5/4              |
| `welcome-room-bunk-bed`     | var-6   | 96x80      | 6.5 x 5.5   | 4/5/5/4              |
| `welcome-room-kitchenette`  | var-0   | 80x88      | 5 x 5.5     | 4/4/5/4              |
| `welcome-room-mini-fridge`  | var-2   | 92x96      | 2.9 x 3     | 5/5/5/5              |

`welcome-room-lockers` **FAILED after six rounds** and was not approved. See below.

## The big lesson: 3/4 projection changes the declared aspect

The renderer is height-authoritative and `resizeSpriteStrategy` uses `fit` for
non-extreme aspects, which letterboxes whenever the drawn aspect disagrees with
the declared canvas by more than ~10%. Padding under the feet fails
`anchor-derivable` AND makes the prop render shorter than its declared `heightFt`.

I initially declared canvases from **flat front-elevation** feet (mini-fridge
2ft wide / 3ft tall = 0.67:1). That is wrong for this project's 3/4 view: the
receding side face adds drawn width. Measured drawn bounding boxes came back at
0.954 (fridge) and 1.042 (lockers). Re-declaring the canvas at the true
_projected_ aspect fixed the mini-fridge instantly (0 -> 8 full-pipeline passes).

**Rule for future briefs:** declared canvas aspect = (front width + foreshortened
depth) : height, not front width : height. Measure a round-1 sheet before
arguing with the model — three rounds were spent telling the model to narrow a
bank that was already correct.

Also confirmed: `sizeVariant: tall` is actively harmful for props. The model
ignores the portrait cell layout and keeps drawing square cells, after which the
content-aware slicer cuts on the _declared_ tall grid and each "variant" becomes
a vertical column of three stacked objects. One such slice passed all 7 sensors
and the judge (4/4/4/5) — a green gate on a garbage sprite, caught only by the
eyeball step. Do not use `sizeVariant: tall` on `prop` briefs.

## welcome-room-lockers — honest failure

Six rounds, no approved variant. No sensor threshold and no judge bar was
touched. The failure is a genuine oscillation between two gates:

- R1-R3: correct three doors, good metal, but drawn near-square against a
  declared 0.75:1 canvas -> letterboxed -> `anchor-derivable` fail.
- R4 (canvas corrected to 100x96): anchor derives, judge 4/5/5/4, but the bank
  is a near-solid rectangle -> `opaque-ratio` 0.70-0.73 vs the 0.65 cap.
- R5 (brief adds legs/gap/sloped cap to open the silhouette): sensors 7/7 on six
  variants, but the model dropped to **two doors** -> judge `brief_match` 1/5,
  hard-blocked. Correct rejection.
- R6 (three-door requirement re-asserted next to the silhouette rules): still
  two doors in every cell, `brief_match` 1/5.

Diagnosis: at ~1:1 the model prefers two wide doors, and the negative-space
instructions that fix density compete for prompt attention with the door count.
Suggested next attempt (not taken here, out of iteration budget): split into
`welcome-room-locker-single` at a genuinely tall 48x96 canvas (triggers the
`height` strategy, no letterboxing) and place three of them side by side in the
set piece, personalising each via the placement rather than one sprite. That also
gives the dresser more layout freedom in a tight 7x6 room.

## Incidental fix: magenta matte on a shipped tile

`npm run check:tile-mattes` flagged `tile-stone-floor-v1-var-2` — 86% of its
256x256 border ring was off-palette magenta, i.e. a chroma-key matte fused into
a _tiled terrain_ asset, shipped back in #869. That is the hot-pink-lattice bug.
Repaired with `scripts/sprites/repair-tile-matte.ts` (8433 px, 12.9%); the
checker is now clean across all 382 generated sprites. This wave introduced no
mattes of its own.

## Prior wave

`welcome-room-floor-scuff-var-4` is not lost. It has manifest + `sprite-catalog`
entries committed on this branch (`10cbcab3f`) and rides the still-open check-in
branch behind issue #2070 / PR #2071, both of which remain OPEN and unmerged as
of this session. #2070 no longer carries the `asset-checkin` label, so the
`asset-pr` consolidation did not sweep it up; PR #2071 needs merging on its own.

## Systems touched

- `briefs/props/` — six new prop briefs (bunk-bed, kitchenette, mini-fridge,
  chore-rota, lockers, laundry-line).
- `public/assets/generated/manifest.json` + `src/shared/data/sprite-catalog.json`
  — five approved variants registered (via `sprites:approve`).
- `public/assets/generated/` — five new PNGs, plus the repaired
  `tile-stone-floor-v1-var-2.png`.
- No engine, gameplay, wiring or set-piece placement code was touched. The props
  are checked in and tracked but not yet placed in `welcome-room`.

## Follow-ups

1. Merge PR #2084 (auto-merge armed) and PR #2071.
2. Place the five props in the `welcome-room` set piece (that is a code PR:
   full gates + apple-scaled review harness + ledger).
3. Retry lockers as a single-locker brief per the suggestion above.
4. `docs/knowledge/game-design/set-piece-lookbook.md` still says "1 tile = 2
   feet". It is stale — the code says `tileSizeFt: 4.0` with
   `PIXELS_PER_FOOT = 8`. Worth correcting before it misleads another wave.
5. `docs/knowledge/handoffs/2026-07-26-stone-floor-art-wave.md` contains
   unresolved `<<<<<<< Updated upstream` merge-conflict markers.
