# Session Handoff: Generic Spawner Mob-Type (Rats Nest + Slime Pool)

## Date

2026-06-27

## Persona(s) adopted

**Producer** routing to **Game Designer** + **Systems Engineer**. The task spans a
new ECS component, a game-layer system, a data registry, two designed archetypes, a
lab, and tests — multi-layer work that the Producer owns and splits across the
design (archetype tuning) and systems (component/system/pipeline) hats.

## Routing verdict

✅ right persona — multi-layer, multi-system feature with data-design tuning; exactly
the Producer + Systems Engineer combination.

## Apples

Estimated: 🍎 x 4 <!-- declared before work began -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — scope landed as planned (component + system + registry + 2
archetypes + core helper + lab + tests + ADR), with floor wiring deliberately
deferred per the agreed scope.

Hello kitties: 4/5 = 0.80 🎀

## Systems touched

enemies

## What Was Done

Added a generic, data-driven **Spawner** mob-type: an immobile, attackable enemy
structure that periodically spawns mobs, with three modes — **passive** (slow
trickle), **defensive** (enrages on first damage), and **on-death** (one-shot
finale wave). Implemented two archetypes: **Rats Nest** (rats / rat brutes →
Rat King or Queen + rats on death) and **Slime Pool** (slimes → more/faster
slimes when enraged → Mama or Papa Slime + slimes on death).

- `src/core/components.ts` — `Spawner` tag + store `{ defIndex, mode, nextSpawnMs,
spawnedTotal, deathResolved }`; wired its observer in `src/core/world.ts`.
- `src/core/helpers.ts` — `spawnSpawner(world, x, y, hp, opts)` core factory. No
  `Velocity` / `EnemyBehavior` ⇒ immobile (skipped by movement + AI) but still
  collides and is attackable.
- `src/game/spawners/` — `types.ts`, `registry.ts` (mob templates + `RATS_NEST` /
  `SLIME_POOL` archetypes + lookups + pure `pickFromPool`), `spawnerSystem.ts`,
  `index.ts` barrel.
- `src/game/index.ts` — exported the system, registry helpers, and types.
- `src/labs/spawner-lab/` — Phaser + lil-gui lab (`index.ts` + `README.md`) with
  poke/destroy/clear/respawn controls and a live mode/HP/child-count panel;
  registered in `src/lab-main.ts` (`LAB_MODULE_PATHS` + category hint).
- Tests: `tests/game/spawner-registry.test.ts` (9) and
  `tests/game/spawner-system.test.ts` (12) — archetype integrity, weighted
  `pickFromPool`, immobility, passive cap/interval, defensive enrage latch,
  one-shot on-death finale, Owner-tagging, and seed determinism. Strengthened the
  determinism fingerprint (was silently coercing typed-array positions to `0`).
- `docs/knowledge/adr/0025-spawner-mob-type.md`.

## What's Next

1. **Wire into a floor (separate session).** One line — `spawnerSystem(world)`
   immediately after `enemyAISystem(world)` — in `simulation-step.ts` (headless),
   `MainGameScene.ts` (visual), and the floor's pre/post system lists. This was
   intentionally **not** done here to avoid touching Floor 1 pacing.
2. Place Rats Nest / Slime Pool instances in floor content and tune counts/intervals
   against live pacing.
3. Optional: distinct sprites/textureIds per structure and child tier (everything
   currently uses `textureId 0` with size/blood-colour differentiation).

## Blockers

None.

## Branch State

- Branch: `nalfeo-cautious-guide`
- All tests passing: yes (`npm run verify:fast` — 75 files / 769 tests green)
- PR created: no

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — no telemetry section.

## Test Results

`npm run verify:fast` → typecheck clean, lint clean, **Test Files 75 passed (75),
Tests 769 passed (769)**. New spawner suites: 21 tests passing. `npm run verify`
(full) pending as the final gate before commit/PR.

## Key Decisions Made

- New `Spawner` component instead of a spawner `AI_TYPE` on `EnemyBehavior`, so the
  structure stays immobile and spawn logic is isolated from movement AI.
- System lives in `src/game` (needs `AI_TYPE`); the factory stays in `src/core`
  (primitives only) to keep `core` game-data-free.
- Per-spawner concurrency reuses the `Owner` component on children (verified safe;
  only projectiles read `Owner` today).
- Floor/pipeline wiring deferred by agreed scope — system is lab- and test-gated and
  exported, ready to drop into a floor in a follow-up.
