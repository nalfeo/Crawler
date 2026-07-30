# Wire real player walk art + lock player/NPC scale parity

**Date:** 2026-07-29
**Apples:** 2🍎 (estimated) / 2🍎 (actual)

## Systems touched

rendering, sprite-pipeline

## Problem

Two defects were left behind after the player walk-animation slices merged
(PR #2296 "Slice A" engine anims layer, PR #2302 "Slice B" multi-frame
generation pipeline):

1. **The walk animation was completely inert in the real game.**
   `renderKinds.player.generated` in `src/shared/data/entity-sprite-mappings.json`
   pointed at `player-walk-placeholder-v1` / `player-walk-placeholder-v1-var-0`
   — a brief id with **no manifest shard and no PNG anywhere in the repo**.
   `resolveGeneratedTexture()` therefore returned `null` and the player silently
   fell back to the Kenney Tiny Dungeon static frame 96 at `kenneyScale: 1.6`
   (25.6px, no animation, as before both slices).

   The only asset Slice A actually shipped was
   `public/assets/generated/rhea-vale-v1-var-0-walk.png`, which was referenced
   _only_ by `src/labs/movement-lab/index.ts` through a hand-built synthetic
   registry that aliased it to the placeholder key. So the lab animated and the
   real game did not — the exact lab-proves-nothing failure mode ADR 0039 exists
   to catch, except here the seam was a **data mapping**, not a system export, so
   `check:wired-systems` could not see it.

   Meanwhile Slice B's real art (`player-walk-cycle`, 4×64×64 frames @ 8fps,
   all 8 sensors passing) was checked in and fully valid but never wired.

2. **No structural guarantee tied the player's size to the welcome-room NPCs.**
   The two are sized by completely different mechanisms:
   - Welcome-room NPCs are sized in **world feet** — `PhaserBridge` renders them
     height-authoritatively via `setScale(ftToPx(heightFt) / nativeH)`, so their
     drawn height is `heightFt * PIXELS_PER_FOOT` regardless of source art size.
   - The player is sized in **source pixels** — native frame height × the
     `generated.scale` factor in `entity-sprite-mappings.json`.

   Nothing linked those numbers, so the previous `scale: 0.72` (46.08px vs the
   NPCs' 46.0px) was correct only by luck, and any future art regeneration at a
   different frame size would have drifted silently with no failing test.

## Change

- **Wired the real art**: `renderKinds.player.generated` now points at
  `player-walk-cycle` (both `briefId` and `pinnedTextureKey` — the manifest key
  for this shard is the bare sprite name, not a `-var-N` suffix).
- **Pinned exact scale parity**: `0.72` → `0.71875`, i.e. `ftToPx(5.75) / 64`
  = `46 / 64`. The player's drawn box is now exactly the welcome-room NPC height.
- **Added a deterministic guard**: `tests/unit/player-npc-scale-parity.test.ts`
  recomputes both sides from their real sources (`set-pieces.json` NPC
  `heightFt`, `PIXELS_PER_FOOT`, the walk-cycle shard's `animation.frameHeight`,
  and the mapping's `generated.scale`) and asserts they agree. It also asserts
  the player is still pinned to the shard the parity math measures, so the guard
  cannot go vacuously green if the mapping is repointed.
- **Repointed `movement-lab`** at the real `player-walk-cycle` asset (4 frames
  @ 8fps) so the lab and the game now render the same thing.
- **Deleted the orphaned `rhea-vale-v1-var-0-walk.png`** — zero remaining
  references after the lab was repointed.
- Updated the two test fixtures that mirrored the placeholder key.

## Observe before done (real game, not a lab)

Ran `npm run dev` and observed the **real game** (`MainGameScene`), not
`movement-lab`:

- **Before** (main @ `7501fac84`): player rendered as the small Kenney knight
  frame, no animation. Confirmed by code path — `player-walk-placeholder-v1`
  resolves to no texture, so `resolveGeneratedTexture()` returns `null`.
- **After**: player renders as the generated `player-walk-cycle` character.
  Teleported the player next to the welcome-room shopkeeper via the
  `__floor1Debug` hook (NPCs at world x = 394 / 402 / 410, all `5.75 ft`) and
  captured them side by side — **the player and the NPC read as identical
  height**. Held `ArrowRight` and captured consecutive frames: the player's pose
  visibly changes mid-walk, confirming frame advance in the real render path.

The precise numeric parity is proven deterministically by
`player-npc-scale-parity.test.ts`; the frame-advance/idle-hold/flip behavior by
the pre-existing `player-walk-animation.test.ts`.

## Verification

- `npm run verify:fast` — green (1472 unit tests, 103 files).
- Targeted: `player-npc-scale-parity`, `phaser-bridge`, `player-walk-animation`,
  `generated-asset-preload`, `generated-asset-animations` all pass.
- Guard teeth check: the previous `scale: 0.72` yields 46.08px and **fails**
  `toBeCloseTo(46, 5)`, so the new test is not vacuous.

## Follow-ups

- The doc comment above `GENERATED_NPC_SPRITE_SCALE` in `PhaserBridge.ts` is
  stale — it claims generated NPCs land at "~26px on screen, matching the
  player's on-screen footprint", but for any NPC with a positive `heightFt`
  (which includes all welcome-room NPCs) that scale is immediately overwritten
  by the height-authoritative `setScale` below it. Left untouched to keep this
  diff minimal.
- Consider extending a wiring guard to cover **data-level** art pins: a check
  that every `generated.briefId` in `entity-sprite-mappings.json` resolves to an
  existing manifest shard would have caught defect #1 at merge time.
