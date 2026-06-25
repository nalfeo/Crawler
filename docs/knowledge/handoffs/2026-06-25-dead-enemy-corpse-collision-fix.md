# Session Handoff: Dead enemy corpse collision fix

## Date

2026-06-25

## Persona(s) adopted

**Systems Engineer** — the bug lives in ECS system logic (`damageSystem`,
`enemyAISystem`) and their interaction with the death-linger lifecycle
(`dropSystem` → `DeathTimer` → `deathTimerSystem`). No cross-layer coordination
was needed, so no Producer split.

## Routing verdict

✅ right persona — the fix is pure ECS plumbing (component guards in core/game
systems) with deterministic unit tests.

## Apples

Estimated: 🍎 x 2
Actual: 🍎 x 2
Verdict: 🎯 Exact — a focused two-system bug fix plus two regression tests, no
new components/systems/labs required.

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

Fixed dead enemy corpses continuing to follow the player and deal contact damage
during the death-linger window.

Root cause: when an enemy dies, `dropSystem` adds a `DeathTimer` (so the corpse
animation + death knockback slide can play out) but keeps the
`Enemy`/`EnemyBehavior`/`Position`/`Velocity` components until
`deathTimerSystem` removes the entity. During that window:

- `enemyAISystem` still queried the corpse and set a fresh chase velocity → the
  corpse kept following the player.
- `damageSystem.applyPlayerEnemyHit` had no corpse check → the corpse kept
  dealing contact damage on overlap.

Changes:

- `src/game/enemyAISystem.ts`: skip AI for entities with `DeathTimer` — zero
  their velocity, clear path/slime state, and `continue`. The death-slide is
  still applied independently by `knockbackSystem`, which runs later in the
  pipeline.
- `src/core/systems/damageSystem.ts`: `applyPlayerEnemyHit` returns early when
  the enemy has `DeathTimer`, so corpses deal no contact damage.
- Regression tests in `tests/game/enemy-ai.test.ts` (corpse stops chasing) and
  `tests/ecs/damage-system.test.ts` (corpse deals no contact damage, emits no
  combat event).

## What's Next

- Nothing blocking. Optional polish: enemy projectiles spawned by a corpse are
  already prevented (AI is skipped entirely), but if future behaviors fire
  projectiles outside `enemyAISystem`, re-audit for the same corpse guard.

## Blockers

None. (A few transient "policy hook failed / hook errored" tool denials occurred
mid-session; commands succeeded on retry — environmental, not code-related.)

## Branch State

- Branch: `nalfeo-fix-dead-enemy-corpse-collision`
- All tests passing: yes
- PR created: no

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — no telemetry section.

## Test Results

`npm run verify` (full suite) passed: typecheck + lint + format + unit
(212 passed) + integration (24 passed, 1 skipped) + headless Floor 1 completion
gate (4 passed) + production build. `npm run verify:fast` also green.

## Key Decisions Made

- Guard at the AI/damage read sites via `DeathTimer` rather than stripping
  components at death time. This keeps the corpse visible and lets the existing
  death knockback slide (`knockbackSystem`) and corpse render
  (`PhaserBridge` `isDeadEnemy`) continue to work unchanged.
- `enemyAISystem` guard placed at the top of the per-enemy loop and reuses the
  existing `setVelocity(world, eid, 0, 0)` helper for consistency with the
  no-player and out-of-aggro idle paths.
