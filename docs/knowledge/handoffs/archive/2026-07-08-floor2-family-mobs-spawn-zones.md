# Handoff: Floor 2 family mobs, generic spawn-zone union, and placeholder-art tracking

**Date:** 2026-07-08  
**Session:** Floor 2 family mobs (branch `nalfeo-floor2-family-mob-roster`)  
**Apple estimate:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** exact  
**Review ledger:** `docs/knowledge/review-ledgers/2026-07-09-floor2-family-mobs-spawn-zones.review-ledger.json` (valid 2🍎)

## Systems touched

enemies, mapgen, sprite-workflow

## Summary

Expanded Floor 2 family rosters to full four-role composition (boss + elite + ranged basic + melee basic), made ambient spawn-zone resolution generic and shared across floors, and added explicit placeholder-art tracking for enemy archetypes that still lack dedicated generated art.

## What changed

- Added `src/game/spawn-zones.ts` with reusable zone-weight merge/normalize/pick helpers.
- Updated Floor 2 spawn selection (`src/game/floor2Scenario.ts`) to union in-scope zone contributions (family territory + quadrant + global).
- Updated Floor 1 spawn selection (`src/game/floorScenario.ts`) to use the same shared zone-selection utility (single global zone input).
- Expanded `src/shared/data/enemies.floor2.json` roster and weights so each family has:
  - 1 elite (`spawnWeight: 0.01`)
  - 1 ranged basic (`spawnWeight: 0.25`)
  - 1 melee basic (`spawnWeight: 0.74`)
- Added/updated Floor 2 appearance wiring in `src/engine/phaser-bridge/sprite-kind.ts` for the expanded roster.
- Extended placeholder-audit sources:
  - `scripts/sprites/placeholder-audit.ts`: new placeholder source kind `enemy-pack`, new `enemyArchetypeIds` input, and concept-level placeholder-needed detection when dedicated generated art is missing.
  - `scripts/sprites/placeholder-audit-cli.ts`: now feeds floor1/floor2 archetype ids into audit input.
- Updated/added tests:
  - `tests/unit/spawn-zones.test.ts`
  - `tests/unit/enemies-floor2-schema.test.ts`
  - `tests/unit/floor2-director-territory.test.ts`
  - `tests/unit/floor2-enemy-art-wiring.test.ts`
  - `tests/unit/sprites/placeholder-audit.test.ts`

## Verification run

- `npm run test -- tests/unit/sprites/placeholder-audit.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Unresolved issues / tradeoffs

- Expanded placeholder-audit output is noisier by design because enemy archetypes now appear in placeholder-only lists when dedicated generated art is not present.
- Some new Floor 2 archetypes currently map to existing/reused generated briefs for runtime rendering; they are still tracked as placeholder-needed for future unique art generation.

## Recommended next steps

1. Use `npm run sprites:placeholder-audit -- --all` after art check-ins to burn down `enemy-pack` placeholder entries for Floor 2 mobs.
2. Generate and approve dedicated art for high-priority new elites/basics first, then rerun audit to confirm placeholder-only counts drop.
