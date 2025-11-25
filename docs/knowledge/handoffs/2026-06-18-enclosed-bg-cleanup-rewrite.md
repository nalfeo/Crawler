# Handoff — Enclosed background cleanup rewrite

**Date:** 2026-06-18
**Branch:** `nalfeo/launching-sprites`
**Apple:** declared 🍎🍎🍎 · actual 🍎🍎🍎 · verdict exact · 🐱 0.6

## Systems touched

ai-pathfinding

## What changed

Rewrote the **enclosed background-region cleanup** in `scripts/sprites/postprocess.ts`
from scratch. The previous implementation was a stack of heuristic passes
(size cap, center-seed flood, magenta-family detection, lower-half artifact
sweep) that simultaneously **failed** to remove the big enclosed magenta region
between the rat-bruiser's legs **and over-cleared** legitimate sprite detail
(arms, feet, sword, embedded body shadows).

### New algorithm — `clearEnclosedBackgroundRegions`

For every opaque pixel within `toleranceSq` squared-RGB distance of any corner
colour, flood-fill (4-connected) its connected component of like-coloured
candidates, tracking whether the component touches the image border. After the
component is built, clear it (alpha = 0) **only if it does not touch the border**
and has area ≥ `BACKGROUND_B_ENCLOSED_MIN_AREA` (= 4). No size cap, no
centroid/shape/magenta heuristics. O(n).

**Why it works:** shadows are semi-transparent grey over pink ≈ (180,120,170),
squared-distance to magenta ≈ 27,250 — far beyond the enclosed tolerance
(fringe 12,000), so they are never candidates and are preserved. Pure background
pockets sit at distance 0–8,000 → candidates. Topology (not-touching-border)
distinguishes a trapped interior pocket from exterior background.

### Constants

- Removed: `BACKGROUND_B_MAX_ENCLOSED_ISLAND_PIXELS`,
  `BACKGROUND_B_ENCLOSED_MAX_COMPONENT_DISTANCE_SQ`, all `BACKGROUND_B_CENTER_*`,
  all `BACKGROUND_B_MAGENTA_ARTIFACT_*`.
- Added: `BACKGROUND_B_ENCLOSED_MIN_AREA = 4`.
- Kept: `BACKGROUND_B_COLOR_TOLERANCE_SQ = 4000`,
  `BACKGROUND_B_FRINGE_TOLERANCE_SQ = 12000` (the enclosed pass uses fringe
  tolerance as its colour tolerance).

### Tests (`tests/unit/bg-remove.test.ts`)

Deleted 2 heuristic-encoding tests; rewrote 3 to assert the new topology
contract (large bg cavity cleared regardless of size; large shadow cavity
preserved; small border-sealed bg pocket cleared). 111 tests pass.

## Verification

Visually verified via Playwright against the live sidecar debugger
(`devtools.html?page=postprocess&briefId=rat-bruiser-v2&runId=2026-06-18T21-29-16-d23cf957&variantIndex=4`).
Screenshots in session `files/`: `enc2-step.png` (before/after of the enclosed
step) and `enc2-final.png` (final output). Big leg-gap magenta region gone;
arms/feet/sword/body shadows preserved.

`npm run verify:fast` green (typecheck + lint + 111 tests).

## Known minor remnant

A tiny ground-shadow patch at the very bottom of the sprite **touches the
border**, so the topology gate correctly leaves it. It is pink-ish because the
generated sprite's cast shadow shares the background colour family — a
**prompt-side** issue already addressed by the shadow-colour guardrail added
earlier this session; it will improve on regenerated assets, not via the slicer.

## Pipeline / ops notes

- Postprocessing runs in the **sidecar** (tsx, live transpile), not the browser
  bundle. After any `postprocess.ts` change, **restart the sidecar**
  (`npx tsx scripts/sprites/sidecar/cli.ts`, detached) so the debugger reflects
  it. Port is deterministic per-worktree (20230 here); vite/devtools on 20221.
- The debugger's `/api/postprocess` route lives in the sidecar `server.ts`;
  `src/devtools-main.ts` calls it.

## Status

- [x] Algorithm rewritten, tests rewritten, verify:fast green
- [x] Visually verified on rat-bruiser
- [x] Committed (`235cbee`) and pushed to `nalfeo/launching-sprites`
- [x] apple-log + handoff updated
- [ ] **No PR opened** — per user instruction, wait for explicit request

## Next

- If a regenerated rat-bruiser still shows a pink ground shadow, confirm the
  shadow-colour prompt guardrail is taking effect on new runs.
- Open the PR only when the user explicitly asks.
