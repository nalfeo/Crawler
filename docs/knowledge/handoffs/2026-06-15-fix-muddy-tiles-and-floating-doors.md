# Session Handoff: Fix muddy tiles and player-following door sprites

## Date

2026-06-15

## Apples

Estimated: 🍎 x 2
Actual: 🍎 x 2
Verdict: 🎯 Exact — two surgical rendering fixes (one config flag, one
camera-ignore call). The cost was almost entirely root-cause investigation via
Playwright screenshots + temporary in-scene logging, not net-new logic.

## What Was Done

Fixed the two regressions the user reported after CC0 art was wired into the
main game: (1) "everything looks so muddy and bad" and (2) "weird door sprites
that just hang out and follow the player."

### Regression 1 — muddy / blurry tiles + dark grid seams

- **Root cause:** `src/main.ts` Phaser game config lacked `pixelArt` /
  `roundPixels`. Phaser 4 defaults to **LINEAR** texture filtering, which blurs
  pixel art and samples the 1px sheet spacing at tile edges → muddy look + dark
  seams between tiles. The visual-snapshot lab always looked clean because it
  sets `pixelArt: true`.
- **Fix:** added `pixelArt: true, roundPixels: true` to the main game config
  (`src/main.ts` ~line 49). Confirmed crisp via Playwright.

### Regression 2 — doors "follow the player"

- **Root cause (the interesting one):** `MainGameScene` runs a two-camera
  setup — a scrolling **world camera** (`cameras.main`) and a scroll-locked
  **`uiCamera`** at `setScroll(0,0)`. `refreshCameraMasks()` partitions scene
  children by depth into ignore lists so each camera only draws its half. Crucial
  ordering, every frame in `update()`:
  1. `refreshCameraMasks()` (line ~429) rebuilds the ignore lists from the
     **current** children.
  2. `updateDoorOverlay()` (later in the same frame) **destroys and recreates**
     every door image.
     The freshly created door images therefore never make it into the `uiCamera`'s
     ignore list for that frame, so the **scroll-locked UI camera draws them at raw
     world pixel coordinates**. Doors at low tile coords cluster in the top-left
     screen space and, because the player is screen-centered, appear to flank and
     "follow" him. (Proven by temporarily tinting overlay doors red + labeling each
     with its tile coords — the floating doors were labeled `14,12` / `22,12`, far
     from the player's tile `40,17`.)
- **Fix:** call `this.uiCamera?.ignore(img)` immediately after creating each
  door overlay image in `updateDoorOverlay()`. This guarantees only the
  scrolling world camera ever renders them, independent of mask-refresh timing.
- Also removed all temporary debug scaffolding from `updateDoorOverlay()`
  (red tint, per-door text labels, `[map]` ASCII terrain dump, `[door-overlay]`
  warn). Kept the wall-adjacency guard (only stamp a door where it's set into a
  wall run) — it is correct and harmless.

## Files Changed

- `src/main.ts` — added `pixelArt: true, roundPixels: true`.
- `src/engine/scenes/MainGameScene.ts` — `updateDoorOverlay()`:
  `uiCamera.ignore(img)` per door image; stripped debug code.

Commit: `fix: door overlay scrolls with world camera and crisp pixel filtering`.

## Verification

- `npm run verify:fast` — **1144 tests pass**, typecheck + lint clean.
- Playwright screenshot of the live main game (`files/verify-doors.png`):
  knight stands alone in a clean room, **no doors flanking the player**; doors
  sit correctly embedded in the brick walls; pixel art is crisp with no muddy
  blur or grid seams.

## Notes / Follow-ups

- The big flat orange room still uses a single floor tile with no variation —
  this is a **pre-existing, separate concern** (floor-tile variation), not part
  of these two regressions. Out of scope here.
- Full `npm run verify` still has flaky **TIMEOUTs in sprite-generation
  integration tests** under parallel load — unrelated to art/rendering; they
  pass in isolation.
- This is all **temporary CC0 bridge art**; the procedural sprite-generation
  pipeline remains the long-term path and was deliberately untouched.
- Branch: `nalfeo/cc0-visual-snapshot-art` (workspace label `nalfeo/urban-pancake`
  is stale — do not rename).
