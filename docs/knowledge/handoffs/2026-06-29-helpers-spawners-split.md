# Session Handoff: Decompose src/core/helpers.ts into spawners/ modules

## Date

2026-06-29

## Persona(s) adopted

**Engine/Systems** — the work is a pure-ECS reorganization inside `src/core/`
(entity spawner helpers), no rendering or game-layer concerns. Workstream B of a
refactor/cleanup fan-out (siblings: A = property tests, C = bt-ai-provider).

## Routing verdict

✅ right persona — the task was self-contained `src/core/` surgery with a strong
deterministic safety net (headless Floor 1 gate), exactly the Engine/Systems lane.

## Apples

Estimated: 🍎 x 2
Actual: 🍎 x 2
Verdict: 🎯 Exact — mechanical, behavior-preserving extraction; the 15-file count
nudged toward Medium but per-file complexity stayed Small and there were no
surprises beyond two trivial lint/format fixups.

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

enemies

## What Was Done

- Split the ~725-line god-module `src/core/helpers.ts` into six cohesive modules
  under `src/core/spawners/`:
  - `entity-core.ts` — `createEntity`, `clearEntityStores`, `setBloodColor`, re-export `DEFAULT_BLOOD_COLOR`
  - `combatants.ts` — `spawnPlayer`, `spawnEnemy`, `spawnBehaviorEnemy`, `spawnSpawner` (+ `SpawnSpawnerOptions`)
  - `pickups.ts` — `spawnXpGem`, `spawnGold`, `spawnDroppedItem`, `spawnWeapon`
  - `projectiles.ts` — `spawnProjectile`, `spawnEnemyProjectile`, `spawnAoeProjectile`, `spawnReturningProjectile`, `spawnBouncingProjectile`, `spawnBeam`
  - `melee.ts` — `spawnAreaAttack`, `spawnMeleeSwing`
  - `world-objects.ts` — `spawnTrap`, `spawnNpc`, `spawnProp`, `spawnHarvestableNode`
  - `index.ts` — `export *` barrel over the above.
- `helpers.ts` is now a thin facade: `export { applyDamage }` + `export * from './spawners/index.js'`.
  Every existing `../core/helpers.js` import is unchanged (signatures + reference identity preserved).
- Relocated the spawn detail tests into per-module suites in `tests/ecs/spawners/`
  and added direct coverage for previously-untested spawners (gold, droppedItem,
  weapon, areaAttack, aoe/returning/bouncing projectiles, beam, trap, prop,
  harvestable, spawner, setBloodColor).
- Rewrote `tests/ecs/helpers.test.ts` as a **facade-contract** test: asserts the
  barrel re-exports each module symbol by reference identity, plus a callable smoke test.

## What's Next

- Optional future cleanup: `src/core/helpers.ts` could eventually be removed in
  favor of importing `src/core/spawners/` directly, but that would touch many
  call sites across layers (needs an ADR) — intentionally out of scope here to
  keep this a single-layer, byte-for-byte-safe refactor.

## Blockers

None.

## Branch State

- Branch: `nalfeo-refactor-helpers-spawners`
- All tests passing: yes (`npm run verify` green — typecheck, lint, format, unit, integration, headless Floor 1 gate, build)
- PR created: yes (see PR link in session)

## Agent-OS Telemetry

N/A — `files/guard-telemetry.jsonl` not present this session.

## Test Results

- `npm run verify:fast`: 76 files / 782 tests passed.
- New spawner suites: `tests/ecs/spawners/*` — 36 tests; `tests/ecs/helpers.test.ts` — 4 tests.
- `npm run verify` (full): unit + integration (49 passed / 1 skipped) + **headless Floor 1 win-rate gate (17 passed)** + production build all green. The headless gate is the behavior-preservation proof.

## Key Decisions Made

- **Facade over rename.** Kept `helpers.ts` as a re-export barrel rather than
  rewriting call sites, so the diff stays inside `src/core/` (no ADR trigger) and
  behavior is provably identical.
- **Grouping by domain**, mirroring the workstream brief (combatants / pickups /
  projectiles / melee / world-objects / entity-core), so related spawners and
  their shared imports live together.
- **Reference-identity facade test** locks the contract: if a future edit drops a
  symbol from the barrel, the test fails immediately.
