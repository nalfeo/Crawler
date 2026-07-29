# Handoff: Quarter-tile FOV resolution (2026-06-30)

## Systems touched

ai-pathfinding

## Summary

Upgraded the FOV/fog-of-war system from full-tile to quarter-tile (2× per axis)
resolution. The `FloorMap.visible` bitmap is now `(2W)×(2H)` — 4× the original
size — and rot-js `RecursiveShadowcasting` runs in sub-tile space. The fog
overlay in `MainGameScene` uses the new `isVisibleSubtile` query for smoother
fog edges; entity visibility (PhaserBridge) and game logic (AI, weapons)
continue to use tile-level `isVisible` for consistency.

**Apple estimate:** 🍎🍎 (actual: 🍎🍎 — accurate)

## Files Touched

| File                                                                           | Change                                                                                                            |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/core/map/FloorMap.ts`                                                     | visible 4×; worldToSubTile, isVisibleSubtile, isVisibleAt, subWidth/subHeight added; setVisible/isVisible updated |
| `src/core/systems/fovSystem.ts`                                                | FOV at 2× resolution (doubled radius, sub-tile origin, bit-shift lightPasses)                                     |
| `src/engine/PhaserBridge.ts`                                                   | Entity visibility uses tile-level `isVisible(tx, ty)` — consistent with weapon/AI                                 |
| `src/engine/scenes/MainGameScene.ts`                                           | Fog lighting callbacks use `worldToSubTile` + `isVisibleSubtile`                                                  |
| `src/engine/HudMinimap.ts`                                                     | Fixed direct `visible[]` loop to derive tx/ty and call `isVisible(tx,ty)`                                         |
| `src/game/ai/bt-ai-provider.ts`                                                | Fixed direct `visible[idx]` accesses to use `isVisible`/`setVisible`                                              |
| `tests/ecs/floor-map.test.ts`                                                  | Updated + new tests for sub-tile API                                                                              |
| `tests/ecs/fov-system.test.ts`                                                 | Added sub-tile precision tests                                                                                    |
| `tests/game/behavior-tree-ai.test.ts`                                          | Fixed two stale `visible[idx]` direct writes                                                                      |
| `tests/game/weapon-system-coverage.test.ts`                                    | Fixed `setVisible` to sub-tile coords                                                                             |
| `tests/unit/phaser-bridge.test.ts`                                             | Fixed `setVisible` to TL sub-tile of entity's tile                                                                |
| `docs/knowledge/review-ledgers/2026-06-30-quarter-tile-fov.review-ledger.json` | Review ledger (plan_review + code_review)                                                                         |
| `docs/knowledge/adr/0034-quarter-tile-fov-resolution.md`                       | ADR documenting the decision                                                                                      |
| `docs/knowledge/metrics/apples/2026-06-30-quarter-tile-fov.json`               | Apple metrics                                                                                                     |

## Verification Run

- `npm run verify:fast` — ✅ passed
- `npm run verify` — ✅ 2788/2788 tests pass; format/lint/typecheck clean; ledger valid

## Review Stages

- **Plan review** (gpt-5.4): 5 concerns raised, all resolved
  - Blocking: PhaserBridge reverted from `isVisibleAt` → `isVisible(tile)` for consistency
  - Non-blocking: worldToSubTile seam bias (accepted), CPU acceptable, 2nd test bug
- **Code review** (claude-sonnet-4.6): 1 concern (same `behavior-tree-ai.test.ts` bug); resolved

## Key Design Choices

1. `isVisible(tx, ty)` = OR of 4 quadrants → at least as permissive as before, backward compatible
2. `isVisibleSubtile(hx, hy)` = exact sub-tile → used only in fog rendering
3. Entity hide/show (`PhaserBridge`) uses tile-level, not sub-tile, to avoid "invisible but targetable" paradox
4. `setVisible(hx, hy)` takes sub-tile coords now — callers use `tx*2, ty*2` for TL quadrant

## Unresolved Issues

None. All review concerns addressed.

## Recommended Next Steps

- Visual QA: observe fog edges in-game to confirm smoother diagonal transitions
- Consider connecting `isVisibleAt` for particle/VFX effects that could benefit from sub-tile precision
