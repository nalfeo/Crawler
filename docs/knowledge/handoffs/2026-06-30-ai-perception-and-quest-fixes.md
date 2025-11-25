# Session Handoff: AI Perception & Quest Behavior Fixes

**Date:** 2026-06-30  
**Branch:** `nalfeo-fix-ai-exploration-quest-behavior`  
**Estimate:** 2 apples 🍎🍎 (mid-complexity, AI-logic-focused, gameplay-critical)

## Systems touched

quests

## Summary

Addressed three interconnected AI behavior issues in seed 697392 and general gameplay:

1. **Omniscient mob knowledge** → Restricted to FOV/minimap visibility
2. **Ignored quest opportunities** → Added safe-room NPC prioritization
3. **Running through mobs** → Improved threat-path-blocking detection

All fixes are now committed and reviewed. Review ledger valid (plan_review + code_review, both complete, both clean).

## Files Changed

- `src/game/ai/bt-ai-provider.ts`: Added FOV perception gating (5 call sites: `pickRetreatTarget`, `relocateFromStall`, `sumNearbyEnemyHp`, enemy queries for dodge logic). Implemented same-safe-room check for NPC detour override.
- `src/game/ai/bt-ai-tuning.ts`: Updated stale comment on `DODGE_BLOCK_RADIUS_FT` (was "3ft just outside body contact", now "early smooth curves at ¾ threat radius").
- `tests/game/behavior-tree-ai.test.ts`: Added FOV transition test (permissive → restrictive). All tests passing (63/63).
- `docs/knowledge/review-ledgers/2026-06-30-ai-perception-quest-fixes.review-ledger.json`: Review ledger (2 stages, both clean).

## Verification

- **Fast verify:** ✅ Typecheck + lint + unit tests (63/63 pass)
- **Review harness:** ✅ Plan review (4 concerns, all resolved). Code review round 1 (1 concern, resolved).
- **PR prerequisites:** ✅ Review ledger valid, handoff created.

## Technical Details

### FOV Perception Gating

- Added `hasPerceptionData` flag to track FOV initialization.
- Method `canPerceiveWorldPosition(world, x, y)`: returns `true` if entity is in current FOV **or** accumulated explored tiles (minimap logic).
- Permissive fallback (returns `true`) for unit tests before FOV system runs; becomes restrictive after `hasPerceptionData` is set.
- Applied to all 5 unfiltered enemy/NPC queries: `pickRetreatTarget`, `relocateFromStall`, `sumNearbyEnemyHp`, dodge threat detection, and nearest-NPC lookups.

### Safe-Room NPC Prioritization

- Added `isPointInSafeSpace` import and `RoomRole` import.
- When `world.playerInSafeRoom && NPC is in safe space`, check that **both player and NPC are in the same safe room** (not just any safe room).
- Uses `floorMap.worldToTile()` and `RoomRole.SAFE` bounds check to verify same-room membership, preventing distant quest NPCs on multi-safe-room floors from hijacking routing.

### Threat-Path-Blocking

- Dot-product check `((ex - playerX) * headX + (ey - playerY) * headY) >= DODGE_BLOCK_AHEAD_DOT` correctly identifies threats ahead on travel heading.
- Radius increased 6→10 ft to support early smooth curves (¾ of threat scan radius) instead of emergency-only maneuvers.
- Comment updated to reflect new intent.

## Next Steps

1. Run full `npm run verify` to ensure all CI gates pass.
2. Create PR with consolidated title/description covering all three fixes.
3. Verify on seed 697392 in headless runner to confirm all three issues resolved.

## Unresolved Issues

None. All plan-review and code-review concerns addressed and committed.

## Recommended Next Steps

- If full verification gates (headless floor1, coverage) pass: create PR and merge.
- Test seed 697392 manually in lab/dev if possible to validate the three fixes work end-to-end.
- Monitor floor1 completion rate in subsequent CI runs to ensure perception gating doesn't regress win-rate.
