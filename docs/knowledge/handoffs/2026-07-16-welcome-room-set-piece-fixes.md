# Handoff: Fix welcome-room set-piece broken auto-props

**Date**: 2026-07-16  
**Issue**: #1181 — Welcome room set-piece sprites wrong (goblin, rugs, walls not solid, door broken)  
**Apple estimate**: 2🍎  

## Systems touched

set-pieces, floor1-scenario

## Summary

Removed the broken auto-generated structural tiles from the welcome-room set-piece and fixed a
latent physics-flag bug in `applyWelcomeRoomStructuralTiles`.

The set-piece editor (PR/handoff 2026-07-09) expanded the welcome room from 8×7 to 10×9 and added
auto-generated border tiles. Those tiles caused four distinct visual/gameplay bugs:

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| "Goblin guy" | `junk-pile-left` and `junk-pile-right` props use `prop-junk-pile-v1-var-0/3`, AI-generated sprites that look like creature/goblin figures | Removed both props |
| "Rugs instead of velvet ropes" | 56 `__auto-floor-*` props used `kenney-roguelike-rpg-pack col=11, row=20` — a solid brownish-orange rug-like tile tiled across the entire floor interior | Removed all 56 auto-floor props |
| Walls not solid | 32 `__auto-wall-*` props set `terrain=STONE_WALL` at passable interior tiles, but `applyWelcomeRoomStructuralTiles` only called `setFlags(WALL)` when the tile was ALREADY non-passable (`if (!isPassable)`), so physics flags were never updated | Removed auto-wall props; fixed the physics-flag guard to always apply |
| Door doesn't work | 2 door props at set-piece y=8 stamped to `interior.maxY` — the last interior row — not aligned with actual dungeon door border tiles | Removed door props |

## Files touched

- `src/shared/data/set-pieces.json` — removed 92 props from welcome-room (56 auto-floor, 32 auto-wall, 2 door, 2 junk-pile); 11 purely decorative props remain
- `src/game/floorScenario.ts` — fixed `applyWelcomeRoomStructuralTiles`: removed the `!isPassable` guard so wall-kind props always update physics flags
- `tests/game/floor1-scenario.test.ts` — replaced `applies welcome-room wall/door props to real map tiles` test with `welcome-room set-piece has no structural props and interior stays fully passable`, which both documents the design decision and validates all interior tiles remain passable after stamping

## Design decision

The welcome-room set-piece is now **purely decorative**. Room structure (walls, floors, doors) comes
entirely from the dungeon generator. The set-piece only adds furniture and decoration props on top.

The velvet-rope sprite (`welcome-room-velvet-rope-var-2`) remains — it's a red carpet-style image
rather than a stanchion, but it was previously approved by the pipeline. A follow-up sprite
regeneration could improve it.

## Verification

- `npm run verify:fast` — all 326+87 test files pass  
- `npm run verify:pr-prereqs` — passes after this handoff and ledger are committed

## Unresolved issues

- `welcome-room-velvet-rope-var-2` sprite looks more like a red carpet than a velvet-rope stanchion. Low priority cosmetic improvement; could be regenerated with a better brief in a future sprite pipeline session.

## Recommended next steps

- Monitor visual appearance of the welcome room in the running game to confirm goblin/rug artefacts are gone.
- If the velvet-rope appearance is still unsatisfactory, run the sprite pipeline to regenerate a new variant from the `welcome-room-velvet-rope` brief.
