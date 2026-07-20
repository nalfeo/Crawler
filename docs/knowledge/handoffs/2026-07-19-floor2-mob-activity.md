# Handoff - Floor 2 Mob Activity

**Date:** 2026-07-19  
**Branch:** `nalfeo-fix-floor-2-mobs`  
**Estimate:** 3 apples  
**Actual:** 3 apples

## Systems touched

enemies, ai-pathfinding

## Summary

Fixed hostile Floor 2 mobs idling beside the player when irregular cave geometry
placed the two entities in different semantic room IDs. Enemy detection now accepts
direct tile line-of-sight as an alternative to room/door metadata, while retaining
the existing detection-range and safe-room gates.

## Root cause

`enemyAISystem` required an open semantic room door, a shared semantic room, or
permanent aggro before a hostile could detect the player. Floor 2 cave interiors can
have contiguous visible floor across a semantic room boundary, so a nearby mob could
fail all three checks and enter idle wander despite having a clear path to the player.

## Verification

- The pre-fix canonical pipeline repro moved an imp 0.08 ft farther from the player
  over two seconds instead of engaging across the visible room boundary.
- The fixed boundary case closes by more than 8 ft in two seconds.
- A paired opaque-wall case remains below the engagement threshold, proving the new
  path does not aggro through closed geometry.
- All 62 non-boss Floor 2 archetypes move toward the player within two seconds in the
  canonical `createFloorMainSceneOptions('floor2')` plus `runSimulationStep` pipeline.
- `npm run verify:fast` passed.
- In the real Floor 2 game after the fix, nearby hostile mobs damaged the stationary
  player from 999,974 to 999,958 health over two seconds outside a safe room.
- Two-round separate-model code review completed clean.

## Artifacts

- Before-fix live scene: `files/floor2-runtime.png`
- Family engagement observation: `files/floor2-family-engagement.png`
- After-fix live scene: `files/floor2-after-fix.png`

## Review

- Ledger:
  `docs/knowledge/review-ledgers/2026-07-19-floor2-mob-activity.review-ledger.json`
- Plan review recorded four concerns, all resolved with minor plan divergence.
- Code review found one ledger-completion issue in round 1; round 2 was clean after
  recording the completed review stage.
