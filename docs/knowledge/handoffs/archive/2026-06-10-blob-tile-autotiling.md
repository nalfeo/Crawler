# Handoff: Blob-tile autotiling infrastructure

**Date:** 2026-06-10  
**Agent:** Copilot  
**Complexity:** 🍎🍎 — estimated, actual matches (focused single-system change, clear plan)

## What was done

Implemented the 4-directional blob-tile autotiling plan in full.

### Files changed

| File                                 | Change                                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/sprites/tile-visuals.ts` | Added `BlobFrames16` type alias, `frames?` field on `TileVisualDef`, `neighborMask()`, `resolveFrame()` helpers; 16-entry placeholder arrays on `STONE_WALL` and `CAVE_WALL` |
| `src/engine/sprites/index.ts`        | Re-exports `BlobFrames16`, `neighborMask`, `resolveFrame`                                                                                                                    |
| `src/engine/terrain-renderer.ts`     | Uses `resolveFrame()` — zero change to no-`frames` path (existing behaviour preserved)                                                                                       |
| `src/labs/tile-render-lab/index.ts`  | Uses `resolveFrame()` for identical rendering in the lab                                                                                                                     |
| `tests/unit/tile-visuals.test.ts`    | 11 unit tests for `neighborMask`                                                                                                                                             |

### Key design decisions

- **Bit encoding:** N=bit0, E=bit1, S=bit2, W=bit3 → mask 0 = isolated, 15 = fully surrounded.
- **`frame` kept required** — acts as safe fallback if `frames[mask]` is ever undefined.
- **`resolveFrame()` is the single resolution point** — both `terrain-renderer.ts` and the lab import it, so they stay in sync automatically.
- **Out-of-bounds neighbours** → treated as non-matching (mask bit = 0), so edge/corner tiles always get the "open side" variant.

### What still needs doing

The 16-entry `frames` arrays in `TILE_SPRITES` for `STONE_WALL` and `CAVE_WALL` are currently **all set to the base frame** (preserving existing visual behaviour). They need visual tuning:

1. Open `?lab=tile-explorer` → select `kenney-tiny-dungeon`
2. Identify the correct frame for each of the 16 connectivity patterns (mask 0–15)
3. Fill in `src/engine/sprites/tile-visuals.ts` → `TILE_SPRITES[TerrainType.STONE_WALL].frames[mask]`
4. Verify visually in `?lab=tile-render-lab` (the lab now uses the same `resolveFrame` path)

## Apple log

- Estimated: 🍎🍎
- Actual: 🍎🍎 — 5 files, ~200 lines net, one test fix, one review-round refactor
- Verdict: ✅ on estimate
