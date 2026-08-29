# Floor 4 Headliner recovery

## Systems touched

boss-rooms, enemies, inventory, ci-policy

## Summary

Recovered the Floor 4 Headliner review fixes that were previously referenced by
unreachable commits. Forced boss-chest resolution now removes the physical chest
and sidecar entry after a successful reward grant, while a failed grant holds
both normal and overtime transitions until it can retry. Enemy Headliner
projectiles use their caster damage so overtime multipliers apply.

## Files touched

- `src/game/floor4Scenario.ts`
- `src/game/enemyAISystem.ts`
- `tests/unit/floor4-arena-director.test.ts`
- `tests/game/enemy-ranged-shooting.test.ts`
- `docs/knowledge/review-ledgers/2026-08-27-floor4-slice4-headliners.review-ledger.json`

## Verification

- `npm run typecheck`
- `npx vitest run tests/unit/floor4-arena-director.test.ts tests/game/enemy-ranged-shooting.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-27-floor4-slice4-headliners.review-ledger.json`

## Unresolved issues

None.

## Recommended next steps

Let CI recovery reconcile the remaining review threads against the reachable
repairs.
