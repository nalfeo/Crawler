# ADR 0025: Generic Spawner Mob-Type

## Status

Accepted

## Date

2026-06-27

## Estimated Complexity

🍎 x 4 — new ECS component + new game-layer system + data registry + two
archetypes + core factory + lab + tests; spans the spawn and death pipelines but
adds no rendering and needs only one new lab.

## Context

The bestiary so far is made of mobile, self-contained enemies (chase/swarm/ranged/
leaper) plus a global, off-screen `enemySpawnerSystem` that drips enemies in from
the arena edges. We had no **structure** enemy — something that sits still, is
attackable, and produces other mobs as an emergent threat. The design calls for a
reusable "spawner" that supports three behaviours:

1. **Passive** — a slow trickle of common mobs.
2. **Defensive** — enrages (faster / harder / bigger swarm) once the player damages it.
3. **On-death** — a one-shot finale wave (a boss plus stragglers) when destroyed.

Two concrete archetypes are required up front: a **Rats Nest** (rats → rat brutes
→ Rat King/Queen on death) and a **Slime Pool** (slimes → more/faster slimes →
Mama/Papa Slime on death). The implementation must be deterministic, data-driven
(authored like loot tables / NPC defs), and obey the layer rules.

## Decision

Add a generic, data-driven Spawner mob-type assembled from existing primitives.

**Component (`src/core/components.ts` + `world.ts`)** — a `Spawner` tag with a
typed-array store: `{ defIndex, mode, nextSpawnMs, spawnedTotal, deathResolved }`.
`defIndex` indexes the archetype registry; `mode` is `0=passive / 1=defensive`;
`deathResolved` latches the one-shot finale.

**Core factory (`src/core/helpers.ts`)** — `spawnSpawner(world, x, y, hp, opts)`
builds an immobile Enemy: `Position + Health + Sprite + Weight + Enemy +
BloodColor + Spawner` and optional contact `Damage`. It deliberately has **no
`Velocity` and no `EnemyBehavior`**, so `movementSystem` and `enemyAISystem` skip
it, while `collisionSystem` (which queries `[Position, Sprite]`) still registers
contact, so the player can bump it for damage and attack it. The helper takes only
primitives, so `core` stays free of game-data dependencies.

**Registry (`src/game/spawners/`)** — plain interfaces (`MobTemplate`,
`SpawnPoolEntry`, `SpawnMode`, `DeathSpawnGroup`, `SpawnerArchetype`), an
append-only `SPAWNER_ARCHETYPES` array, index/id lookups, and a pure weighted
`pickFromPool(pool, roll)` that takes a precomputed roll in `[0,1)` so selection is
seed-stable and unit-testable.

**System (`src/game/spawners/spawnerSystem.ts`)** — `spawnerSystem(world)` queries
`[Spawner, Position, Health]` and, per spawner: (a) if dead and `deathResolved==0`,
emits the on-death groups once and latches; (b) if `mode==passive` and
`hp < maxHp`, latches to defensive; (c) otherwise, gated by `nextSpawnMs` and a
per-spawner concurrent `maxAlive` cap, spawns `perPulse` children from the active
mode's pool. Children are tagged `Owner{eid: spawner}` so concurrency is counted by
querying living owned enemies; finale children are spawned unlinked so they don't
count against a dead structure. It lives in `src/game` (not `src/core`) because it
references `AI_TYPE` from `enemyAISystem`.

**Pipeline integration is intentionally deferred.** The system is exported and
exercised by a lab (`src/labs/spawner-lab/`) and tests, but is **not** wired into
`simulation-step.ts` or any live floor in this change. Wiring is a single call —
`spawnerSystem(world)` immediately after `enemyAISystem(world)` — to be done by a
future floor-content session so Floor 1 pacing is tuned deliberately.

## Consequences

### Positive

- Reusable: new spawners are pure data (`SPAWNER_ARCHETYPES`), no new code.
- Composes existing primitives (Enemy/Health/Owner/Damage/BloodColor) — no new
  rendering, no bespoke death path; reuses `dropSystem`'s `DeathTimer` linger so
  the on-death finale has time to fire before the structure is removed.
- Deterministic: all randomness flows through `world.rng`; `pickFromPool` is pure.
- Immobility falls out of component composition rather than special-casing.

### Negative

- Per-spawner concurrency reuses the `Owner` component (originally for projectile
  ownership) on enemies. Verified safe today (only projectiles read `Owner`), but
  any future system that assigns `Owner` to enemies must account for child counts.
- `Spawner.defIndex` is a positional index into an **append-only** array; reordering
  `SPAWNER_ARCHETYPES` would invalidate persisted/serialised spawners.

### Risks

- On-death detection depends on the dead structure lingering (via `DeathTimer`)
  for at least one `spawnerSystem` tick. If the death pipeline is reordered to
  remove entities in the same frame they die, the finale must move ahead of removal.
- Not yet exercised inside the full headless/visual pipelines; floor wiring should
  re-verify ordering against `movementSystem`/`collisionSystem`/`dropSystem`.

## Alternatives Considered

- **A dedicated AI_TYPE for spawners on `EnemyBehavior`.** Rejected: it would make
  `enemyAISystem` move/aggro the structure and entangle spawn logic with movement
  AI. A separate component keeps the structure immobile and the concern isolated.
- **Putting the system in `src/core`.** Rejected: it needs `AI_TYPE` and archetype
  data from `src/game`; `core` must stay rendering- and game-data-free.
- **Extending the global `enemySpawnerSystem`.** Rejected: that system is a global
  arena-edge drip with no entity, position, HP, or death — a poor fit for an
  attackable structure with localized, mode-driven spawning.
