# ADR 0042: Durable player-hit signal for ally-defend retaliation

## Status

Accepted

## Date

2026-07-03

## Estimated Complexity

🍎 x 3 — a cross-layer combat→AI signal correction (core `applyDamage` choke
point + game-layer feud prepass) plus threading projectile ownership, with two
real runtime bugs, deterministic frame-loop-drain test coverage, and a re-gate
of the headless Floor-1 win-rate. Builds on the Floor 2 family architecture in
ADR 0040.

## Context

Floor 2 Slice 3 (ADR 0040, scope item 3: "family-aware AI + feuding + hate ramp

- ally defend") introduces **ally-defend**: a friendly family mob retaliates
  against whatever enemy just hit the player. `familyFeudSystem` (a prepass in
  `preSystems`, consumed by `enemyAISystem`) needs to observe "the player was hit
  by enemy X" and arm a time-boxed retaliation latch on nearby allies.

The original implementation read `world.combatEvents` — the transient per-frame
combat-event queue — scanning for a player-`hit` event carrying the attacker's
`sourceEid`, tracked across frames with a persistent cursor. This passed
direct-call unit tests and the headless pipeline, but was **dead in the real
visual game**, for two compounding reasons:

1. **The transient queue is drained before the prepass reads it.**
   `familyFeudSystem` runs in `preSystems`, which execute _before_ `damageSystem`
   pushes the player-hit event. At the end of each rendered frame,
   `bridge.sync → combatVfx.update` drains `world.combatEvents` to length 0
   (`src/engine/CombatVfx.ts` consumed by `src/engine/scenes/MainGameScene.ts`).
   So a hit event pushed during frame N is gone before the prepass runs in frame
   N+1 — ally-defend silently never fired. The headless pipeline
   (`src/game/ai/simulation-step.ts`) **never drains `combatEvents`**, so it
   masked the bug entirely (this is exactly the "lab/headless masks a real-frame
   bug" trap that AGENTS.md rule #10 warns about).

2. **The recorded attacker was a dead projectile, not the shooter.**
   `spawnEnemyProjectile` never attached an `Owner` component, so
   `applyEnemyProjectileHit` (in `damageSystem`) recorded the transient
   projectile eid — destroyed on impact — as the `sourceEid`. Even if the signal
   had survived, the ally would have armed retaliation against an entity that no
   longer exists, never against the enemy that actually fired.

## Decision

1. **Durable per-world player-hit signal.** Add an optional
   `lastPlayerHit?: { attackerEid: number; atMs: number }` field to `GameWorld`,
   set at the **core `applyDamage` choke point** whenever the player takes
   damage from a known source (`isPlayerTarget && sourceEid >= 0`).
   `familyFeudSystem` reads this durable signal instead of scanning the transient
   queue, arming the retaliation latch while `hit.atMs + windowMs > elapsedMs`.
   Because the signal is plain world state (not the VFX-owned event queue), it
   **survives the frame-end drain** and behaves identically in the visual and
   headless pipelines — one code path, no ordering coupling to the render loop.
   `resetFamilyFeudState` clears it so a world reset cannot re-arm on stale data.

2. **Thread projectile ownership.** Add an optional `ownerEid` parameter to
   `spawnEnemyProjectile` (forwarded to `spawnProjectile`'s existing `Owner`
   wiring) and pass the firing enemy's eid at the `enemyAISystem` call site. The
   firing **enemy** is now recorded as `sourceEid`, so retaliation targets the
   shooter, not the destroyed projectile.

## Consequences

### Positive

- Ally-defend actually fires in the real visual game, and targets the enemy that
  fired — the headline Slice 3 feature now works end-to-end, not just in
  isolation.
- A single durable code path serves both the visual and headless pipelines, so
  headless win-rate runs and the live game agree on retaliation behavior; the
  fragile "prepass reads a queue that a later render step drains" race is gone.
- Determinism is preserved: the signal is set from `world.elapsedMs` and
  `sourceEid` (no `Date.now`, no RNG), so replays are stable.

### Negative

- `GameWorld` gains one optional field. `lastPlayerHit` records only the
  **most-recent** attacker; the latch design only needs the latest hit, but a
  future feature wanting multi-attacker history would need a richer structure.

### Risks

- If a future system needs to distinguish _melee_ vs _ranged_ or per-attacker
  retaliation history, the single-slot signal is insufficient. _Mitigation:_ the
  field is small and localized; widening it later is a contained change, and the
  choke-point write site is the natural place to enrich it.
- Attaching `Owner` to enemy projectiles is collision-safe: `collisionSystem`
  does not read `Owner` (verified), and only `applyEnemyProjectileHit` /
  retaliation consume it.

## Alternatives Considered

- **Reorder the pipeline so the feud prepass runs after `damageSystem` and
  before the VFX drain.** Rejected: it couples AI decision ordering to the
  render-frame drain point, and the headless pipeline has no drain — so the two
  pipelines would diverge and the same class of bug could silently return.
- **Make `combatVfx.update` clone or not drain the queue.** Rejected: VFX
  ownership of the transient queue is intentional, and cloning adds a per-frame
  allocation on the hot path purely to work around a consumer-ordering problem.
- **Keep scanning `world.combatEvents` with a persistent cursor.** Rejected: this
  was the round-1 approach; it still loses the race against the frame-end drain
  in the visual game (the queue is empty by the time the prepass reads it).
- **Fold retaliation directly into `enemyAISystem`'s per-mob loop.** Rejected:
  keeping it in the `familyFeudSystem` prepass preserves the stable
  `getFamilyAIDecision()` observable used by tests and the lab overlay, and keeps
  the ~1810-line `enemyAISystem` surface unchanged.
