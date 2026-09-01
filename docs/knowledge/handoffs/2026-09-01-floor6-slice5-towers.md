# Handoff: Floor 6 Slice 5 — authored-site towers

## Systems touched

mapgen, inventory, enemies, weapons, vfx

## Apples

5 apples estimated, 5 apples actual (exact). This added a Floor 6 runtime tower subsystem spanning manifest validation, ECS tags/stores, scenario transactions/systems, real headless wiring, ADR, and focused tests.

## Summary

Implemented Floor 6 Slice 5's starter tower contract:

- Added ADR 0101 for the Floor-6-scoped authored-site tower architecture.
- Added validated manifest data for the original starter roster: `spotlight-lancer`, `cable-snare`, and `ratings-mortar`.
- Added Floor 6 tower/effect ECS tags and stores.
- Added scenario-owned build/upgrade/sell transactions that only accept authored build-site IDs, reject illegal/double occupancy atomically, spend run-scoped build currency, and keep UI out of state ownership.
- Added `floor6TowerSystem` to the real Floor 6 scenario pipeline before raider movement.
- Tower attacks select legal raiders by range + `FloorMap.hasLineOfSight`, break ties by distance → manifest index → eid, then apply damage through `applyDamage`.
- Tower shot/effect entities are bounded per tower definition and cleaned by terminal teardown.
- Existing Slice 4 upgrade offers now apply their effects exactly once: relay max HP, relay repair, tower damage, tower fire rate, and raider slow.

## Files touched

- `docs/knowledge/adr/0101-floor6-authored-site-tower-contracts.md`
- `src/core/components.ts`
- `src/core/world.ts`
- `src/game/floor6Scenario.ts`
- `src/game/scenarioDefinitions.ts`
- `src/shared/data/floors/floor6.manifest.json`
- `src/shared/floor-manifest.ts`
- `src/shared/floor-types.ts`
- `tests/headless/floor6-towers-obs.test.ts`
- `tests/unit/floor6-towers.test.ts`

## Verification run

- `npx vitest run --project unit tests/unit/floor6-towers.test.ts tests/unit/floor6-economy.test.ts tests/unit/floor6-wave-director.test.ts`
- `npx vitest run --project headless tests/headless/floor6-towers-obs.test.ts tests/headless/floor6-economy-obs.test.ts tests/headless/floor6-wave-director-obs.test.ts tests/headless/floor6-foundation.test.ts`
- `npm run format:check`
- `npm run typecheck`
- `bash scripts/agent/verify-fast.sh`

## Real artifact observation

- Before: Slice 4 handoff recorded that Floor 6 economy/offers existed in the real headless pipeline, but tower/site combat effects were intentionally deferred.
- After: `tests/headless/floor6-towers-obs.test.ts` runs the real Floor 6 headless pipeline, builds every starter tower through scenario transactions, applies all tower upgrades and selected run upgrades, observes tower combat trace entries, verifies bounded active effects, and replays the same combat trace for the same seed and decisions.

## Unresolved issues

- UI remains future work. Presentation must call the scenario transaction helpers and must not shadow tower/site state.
- Tower effects are deterministic bounded shot/effect carriers, not collision-driven visible projectiles. If later visuals require moving projectiles or summons, graduate that through a separate shared primitive.
- Final Floor 6 balance numbers remain a later human-gated tuning pass.

## Recommended next steps

- Wire a player-facing Floor 6 build/upgrade/sell UI to these transaction helpers.
- Add art/sprite presentation for tower entities and bounded shot effects once the UX/art slice is scheduled.
- Use `RunStats.floor6Defense.towers` when validating later Floor 6 defense balance or UI regressions.
