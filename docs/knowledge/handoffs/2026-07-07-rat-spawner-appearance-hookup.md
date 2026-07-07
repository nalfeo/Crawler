# Session Handoff: Rat monarch/spawner appearance hookup + brute visuals

## Date

2026-07-07

## Persona

Systems Engineer

## Systems touched

enemies, hud-ux, mapgen

## Apples

Estimated: 2🍎  
Actual: 2🍎  
Verdict: 🎯 Exact

## Summary of work completed

- Hooked rat monarch appearance keys to generated briefs:
  - `rat-king -> rat-king-v1`
  - `rat-queen -> rat-queen-v1`
- Hooked spawner appearance keys in the renderer mapping:
  - `rats-nest -> rats-nest-v1`
  - `slime-pool -> slime-pool-v1`
- Wired static spawner entity appearance assignment in Floor 1 spawning path
  so spawner brief lookup can resolve from live entity identity.
- Changed Rat Brute sprite footprint to exactly 25% larger than baseline rat
  (`1.875ft` vs `1.5ft`).
- Added darker-grey Rat Brute tint via a centralized enemy tint policy helper,
  while preserving tint precedence (`spawner red > brute gray > none`) and corpse
  tint precedence.
- Updated tests for monarch/spawner mapping, brute size ratio, and tint behavior.

## Files touched

- `src/engine/phaser-bridge/sprite-kind.ts`
- `src/engine/PhaserBridge.ts`
- `src/game/floorScenario.ts`
- `src/game/spawners/registry.ts`
- `tests/unit/phaser-bridge-sprite-kind.test.ts`
- `tests/unit/phaser-bridge.test.ts`
- `tests/game/spawner-registry.test.ts`
- `docs/knowledge/review-ledgers/2026-07-07-rat-spawner-appearance-hookup.review-ledger.json`
- `docs/knowledge/adr/2026-07-07-rat-spawner-appearance-hookup.md`

## Verification run

- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-07-rat-spawner-appearance-hookup.review-ledger.json` ✅
- `npm run verify` ran; final failure was expected PR-precheck artifacts (now added in this session).

## Unresolved issues

- Generated manifest currently contains `rat-king-v1`, `rat-queen-v1`, and
  `slime-pool-v1` entries, but no `rats-nest-v1` entry was found. Rats-nest now
  uses the correct hookup path and will pick dedicated art automatically once
  that brief appears in the manifest.

## Recommended next steps

- Add/approve `rats-nest-v1` generated asset so rats-nest can resolve dedicated
  art immediately via the now-wired mapping path.
- Keep future spawner/elite appearance-key additions synchronized between spawn
  assignment and `generatedBriefIdForEnemy` mappings.
