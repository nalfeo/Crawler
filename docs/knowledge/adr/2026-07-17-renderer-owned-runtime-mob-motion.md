# ADR 2026-07-17: Renderer-Owned Runtime Mob Motion

## Status

Accepted

## Date

2026-07-17

## Estimated Complexity

🍎 x 5 — establishes a shared motion contract across Floor 1/2 enemy data,
combat-event metadata, entity lifetime identity, Phaser rendering, the Mob Motion
Lab, and a real-bridge integration gate.

## Context

The Mob Motion Lab demonstrated readable spawn, locomotion, attack, hit, death,
and status treatments, but the shipped game rendered living enemies as static
images. Applying those treatments at runtime must remain cosmetic: it may not
change movement, hitboxes, damage, cooldowns, targeting, statuses, RNG, or any
simulation output.

Attack motion cannot be inferred from distance or cooldown predictions. Ranged
windup and release must follow the existing telegraph/fire state, while contact
motion must happen only after successful contact damage. The bridge also drains
combat events for floating damage VFX, so motion must observe authoritative hit
events before that drain. Finally, bitecs can recycle an entity id while the
renderer still owns timing state for the prior occupant.

## Decision

1. Put dependency-free transform samplers and the complete eligible Floor 1/2
   runtime profile catalog in `src/shared/mob-motion.ts`. The lab and
   `PhaserBridge` consume the same functions. Profiles are derived from both
   enemy packs and explicitly include the runtime-only mini-slime and Floor 1
   bosses. Spawner components always exclude an entity even if its appearance
   key resembles a mobile archetype.
2. Keep motion timing in a renderer-local map keyed by entity id and a
   monotonically assigned `entityRenderGeneration`. A recycled id therefore
   creates fresh first-seen, fire-baseline, contact, and hit timing. State is
   deleted when the entity is removed or no longer resolves as an eligible
   enemy.
3. Add optional successful-hit `delivery` metadata (`contact` or `projectile`)
   to combat events. The damage system assigns it at the authoritative delivery
   path. The bridge captures enemy-target hit timestamps and player-target
   contact timestamps before `CombatVfx` drains the queue; blocked, missed,
   dodged, and projectile hits cannot trigger contact motion.
4. Drive ranged windup directly from `EnemyBehavior` telegraph progress and
   edge-detect changes to authoritative `lastFireMs` for release recoil. Establish
   the current fire time as the first-seen baseline so an old/default value does
   not synthesize a release.
5. Compose live transforms in this priority order: first-seen spawn, enemy hit,
   successful contact, ranged windup, ranged release, then movement while
   `Velocity` is nonzero. An active speed modifier from
   `world.statusEffectsByEntity` overlays the selected transform and cold tint.
   No status is created or mutated.
6. Preserve existing render contracts: facing remains `flipX`, motion scales
   multiply the positive magnitude of the resolved enemy scale, identity tint
   composes with status and hit flash, and an existing `SpawnAnim` owns spawn
   scale while first-seen motion supplies only its remaining presentation.
   Corpse rendering bypasses every live transform and retains neutral rotation,
   corpse depth, desaturation/fade, blood pool, and skull lifecycle.
7. Gate the contract with one table-driven integration test through the real
   `createPhaserBridge`. The test derives the expected catalog from both packs,
   proves every eligible archetype and applicable state is represented, proves
   spawner exclusion and projectile/contact distinction, and snapshots gameplay
   state around every render sync.

## Consequences

### Positive

- Every mobile Floor 1/2 enemy and boss shares readable, family-specific motion
  in the actual renderer without introducing animation state into simulation.
- Lab and runtime sampling cannot drift because they import the same pure
  functions.
- Attack and hit motion follows delivered combat facts rather than renderer
  guesses.
- Generation-aware state makes bitecs id reuse safe for all renderer-owned
  timers.
- The integration gate verifies complete archetype/state coverage and zero
  gameplay-state deltas deterministically.

### Negative

- Each visible eligible enemy adds one small renderer-local state record and a
  handful of arithmetic operations per frame.
- Successful combat events now carry one optional classification field, and
  entity creation assigns a render generation even in headless worlds.
- Runtime-only special archetypes must be kept explicit beside pack-derived
  profiles until they move into a single enemy catalog.

### Risks

- A future mobile enemy outside both packs and the explicit special list would
  remain static. The catalog-equality integration assertion makes such additions
  fail until they receive a profile.
- A new damage-delivery path must classify its successful player hit if it
  expects an attack reaction. Omitting the field fails safely by showing no
  contact motion.
- Transform priority is intentionally exclusive except for active speed status;
  changing it can obscure attack readability or reintroduce corpse conflicts.

## Alternatives Considered

1. **Phaser tweens or animation state per enemy.** Rejected because tween
   callbacks introduce a second timing/lifecycle system, complicate deterministic
   tests and id reuse, and duplicate the lab's sampler logic. Pure
   render-time sampling is cheaper and directly testable.
2. **Add ECS components for spawn, attack, hit, and status animation timers.**
   Rejected because those components would make cosmetic timing part of gameplay
   state and increase headless/simulation surface area. Only authoritative facts
   belong in ECS; presentation history belongs to the renderer.
3. **Infer contact attacks from proximity, cooldowns, or damage amount.**
   Rejected because blocked damage, dodge, invulnerability, and projectile
   impacts would produce false animations. Delivery metadata at the successful
   damage path is unambiguous.
4. **Duplicate the lab formulas inside `PhaserBridge`.** Rejected because tuning
   would drift between preview and runtime. A small custom shared sampler module
   is preferable to buying a general animation library for deterministic scalar
   transforms.
