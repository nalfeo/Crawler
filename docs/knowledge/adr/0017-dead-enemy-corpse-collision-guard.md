# ADR 0017: Guard enemy AI and contact damage against death-linger corpses

## Status

Accepted

## Date

2026-06-25

## Estimated Complexity

🍎 x 2 — touches 2 layers (`src/core`, `src/game`) but adds no new component,
system, or lab; guards two existing read sites against an existing component.

## Context

When an enemy dies, `dropSystem` attaches a `DeathTimer` component so the corpse
persists for a short linger window. During that window the death-knockback slide
(`knockbackSystem`) and the corpse sprite (`PhaserBridge` `isDeadEnemy`) play
out, and `deathTimerSystem` removes the entity once the timer expires.
`healthSystem` already special-cases `DeathTimer` (it skips 0-HP entities that
have one, deferring cleanup to `deathTimerSystem`).

The corpse keeps its `Enemy`, `EnemyBehavior`, `Position`, and `Velocity`
components for the duration of the linger. Two systems that read those
components did not account for the corpse state:

- `enemyAISystem` (in `src/game`) queried `[Enemy, EnemyBehavior, Position,
Velocity]` and produced a fresh chase/steer velocity for the corpse, so dead
  enemies kept following the player.
- `damageSystem.applyPlayerEnemyHit` (in `src/core`) applied contact damage on
  any player↔enemy overlap, so a corpse the player walked into kept dealing
  damage.

This spans two architectural layers (core damage + game AI), which triggers the
ADR requirement.

## Decision

Guard both read sites against the existing `DeathTimer` marker rather than
stripping components at death time:

- `enemyAISystem`: at the top of the per-enemy loop, if the entity has
  `DeathTimer`, zero its velocity via the existing `setVelocity` helper, clear
  its path and slime-leap state, and `continue` (skip all AI). The death-slide
  is unaffected because it is owned by `knockbackSystem`, which runs later in the
  pipeline and queries `[Knockback, Position]` independently of AI.
- `damageSystem.applyPlayerEnemyHit`: return early when the enemy has
  `DeathTimer`, so corpses deal no contact damage and emit no combat event.

This mirrors the pattern `healthSystem` already uses: `DeathTimer` is the single
source of truth for "this enemy is a corpse, treat it as inert except for the
death animation."

## Consequences

### Positive

- Dead enemies no longer chase the player or deal contact damage during the
  linger window — the reported bug is fixed.
- The corpse remains visible and the death-knockback slide still plays, so the
  death feel is unchanged.
- Minimal, surgical change: no new components, systems, labs, or pipeline
  reordering. Consistent with the existing `healthSystem` `DeathTimer` guard.

### Negative

- Two systems now each check `DeathTimer`. The corpse-inert rule is expressed in
  three places (`healthSystem`, `enemyAISystem`, `damageSystem`) rather than one
  central place.

### Risks

- Any future system that drives enemy behavior or damage from outside these two
  systems (e.g. a new projectile-firing or melee system) would need the same
  guard. Mitigated by the regression tests below and this ADR documenting the
  invariant.

## Alternatives Considered

- **Strip `Enemy`/`EnemyBehavior`/`Velocity` at death time.** Rejected: the
  renderer and AI keys off `Enemy`, and the corpse still needs `Velocity` for
  the knockback slide; removing components would complicate rendering and the
  death-slide and risk recycled-ID component bleed.
- **Add a dedicated `Corpse`/`Dead` tag component.** Rejected as redundant —
  `DeathTimer` already uniquely marks the linger state and is already the guard
  `healthSystem` uses. A new tag would add surface area without new information.
- **Filter corpses out of the collision grid.** Rejected: collision results feed
  multiple consumers (traps, item pickup, area damage), and corpses should still
  participate in some of those; the precise fix is at the damage/AI read sites.
