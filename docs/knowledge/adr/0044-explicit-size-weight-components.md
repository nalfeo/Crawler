# ADR 0044: Explicit Size and Weight components for canonical physics

## Status

Proposed

## Date

2026-07-04

## Estimated Complexity

🍎🍎🍎 — touches collision, knockback, damage, every spawner, and every
broad-phase consumer (melee, beam, area, projectile). Data-table refactor
across all mob/prop/projectile defs. No new lab strictly required, but one
is added for validation per Rule #1.

## Context

Today entity "physical size" is `sprite.width`/`sprite.height` — a render
field. `collisionSystem.ts:39` and `knockbackSystem.ts:21–22` both read those
render dimensions as physics half-extents. This conflates rendering with
gameplay in three problematic ways:

1. **Any HiDPI / sprite-scale / VFX tweak silently changes hitboxes.**
   ADR 0025 (HiDPI supersampling) and `sprite.sizeScale` both operate on the
   same field the collision grid reads.
2. **Spawners can't opt out of the identity `body = sprite bounds`
   assumption.** A large mob with a small hurtbox (or vice versa) has no way
   to express that today. Contact damage — the user's motivating case,
   "mobs need to touch player to do damage" — thus fires the moment sprites
   overlap, even when the mob's silhouette is mostly empty air.
3. **`Weight` is not canonical physics yet.** `world.stores.weight.value`
   exists (component defined `components.ts:91`, store wired
   `world.ts:330`, spawners populate it — 180 lb player, 120 lb default
   mob, 200 lb spawner structure, 1 lb projectile, etc.) and a few
   non-physics paths read it (`dropSystem.ts:217` derives a split slime's
   child weight from it; `initializeEnemyAppearance` in `combatants.ts:36`
   rescales it by `sizeScale`), but **no collision/knockback consumer uses
   it**. Knockback is still a flat distance regardless of target mass.

The user's ask makes both of these first-class: "All entities need to have
a size and weight. Size is actually used for collision. Weight is used for
things like knockback."

## Decision

Introduce a canonical `Size` component; make `Weight` a real consumer
(weight-scaled knockback impulse ⇒ displacement); source values from the
owning authored defs, with mob default size, default weight, and allowed
variance ranges living on the mob definition beside sprite/stats/AI data.
Here, a "variance range" is the authored min/max band around that mob's
default body values; Slice 1 may keep it zero-width (`min = default =
max`) and still satisfy the ownership rule.

### New `Size` component

```ts
// src/core/components.ts
/**
 * Physical body of an entity. Read by collisionSystem (broad + narrow phase),
 * knockbackSystem (footprint passability), and every radius query
 * (areaDamageSystem, beamSystem, meleeSwingSystem, trapSystem). Independent
 * of Sprite, which is render-only.
 */
export const Size = {};
```

Store fields (in `createComponentStores`):

```ts
size: {
  /** Bounding radius in feet (canonical spatial unit — ADR 0007/0023). */
  radius: new Float32Array(maxEntities),
  /** Optional box override half-width in ft. 0 ⇒ use `radius`. */
  halfWidth: new Float32Array(maxEntities),
  /** Optional box override half-height in ft. 0 ⇒ use `radius`. */
  halfHeight: new Float32Array(maxEntities),
  /** 0 = circle (default), 1 = axis-aligned box using halfWidth/halfHeight. */
  shape: new Uint8Array(maxEntities),
},
```

Collision consumers read from `Size`, not `Sprite`. Fallback shim during
Slice 1: if `radius` is zero AND box half-extents are zero, fall back to
`sprite.width * 0.5` / `sprite.height * 0.5` and log a coverage warning in
dev. A `scripts/agent/health/check-size-coverage.ts` gate lists any entity
class still missing Size and must be empty before Slice 2 lands.

### Weight as knockback denominator

Knockback WRITERS (meleeSwingSystem, projectiles, `applyPlayerEnemyHit`,
corpse explosion, area damage) already carry a "knockback" scalar — a
displacement distance in ft. Keep that scalar as its shipping value
(`writerImpulse`) and scale it by the mass ratio `120 / targetWeight`, so a
120 lb median target is unchanged and no per-writer recalibration is needed
(the canonical form documented in `entity-sizing.md` §"Knockback baseline
math"):

```ts
// Existing writer (meleeSwingSystem.ts); writerImpulse is today's scalar
knockback.speed[eid] = writerImpulse * (120 / Math.max(1, targetWeightLb));
knockback.remaining[eid] = writerImpulse * (120 / Math.max(1, targetWeightLb));
```

- Median mob = 120 lb, so a 120 lb target sees the same visible knockback as
  today with **no constant changes** — the `120 / targetWeight` ratio is 1.0
  by construction. Lighter mobs (60 lb bat) get 2×; heavier mobs (240 lb
  ogre) get 0.5×. Spawner structures (`spawnSpawner`, 200 lb default) never
  move under knockback in any code path (they aren't in
  `query(Knockback, Position)`), so the number is a display-only tag for
  them; wall/door terrain isn't a `Weight`-bearing entity at all.
- Entities with `Immovable` or `Weight ≥ IMMOVABLE_THRESHOLD` (e.g. 10 000
  lb, reserved for statues / bosses that specifically shouldn't slide)
  drop applied impulses entirely.

### Authored definition ownership

`docs/knowledge/game-design/entity-sizing.md` remains the human-readable
design reference, Slice-1 sprite-parity worksheet, and review aid — but it
is **not** the authoring home for mob rows. Mob default size, default weight, and
allowed variance ranges live on the mob definition record that already
owns sprite/stats/AI data (today `MobTemplate` in
`src/game/spawners/registry.ts`; if mobs later unify under shared defs,
the same rule applies there). Player/projectile/prop/spawner values live
with their own local authored defs. `src/core/physics-defs.ts` is the
composed runtime registry, and CI fails on missing entries, schema drift,
or mismatched numeric values between the authored defs, the composed
runtime view, and the review sheet.

## Consequences

### Positive

- Sprite tweaks (HiDPI, sizeScale, VFX overlays, art re-slicing) can no
  longer silently change hitboxes.
- Mob-touch-player contact damage now fires at silhouette contact, not
  sprite-bounds contact. Contact damage becomes tunable per-mob.
- Weight matters. Big mobs shrug off knockback, small mobs punt hard —
  cheap, visible gameplay depth.
- Every entity has both fields explicitly set; the "did I remember to give
  this a body?" class of bug is a hard CI failure via `check:size-coverage`.

### Negative

- Slice 1 must land the shim + `check:size-coverage` before Slice 2 can
  land the weight-knockback change, or systems that fall through the shim
  will behave inconsistently. Two-PR sequencing overhead.
- Knockback recalibration touches balance. Requires win-rate re-run to
  clear Rule #13's 90% Floor 1 gate.
- Extra Float32Array × 3 + Uint8Array × 1 per entity slot at
  DEFAULT_MAX_ENTITIES = 10 000 — 130 KB, negligible.

### Risks

- Silent broad-phase drift for melee/area/beam queries whose radii were
  hand-tuned against the current (sprite-based) hitboxes. Mitigation: keep
  numeric half-extents in the data table identical to today's shipping
  sprite dims for Slice 1; only Slice 2 changes semantics.
- If a future contributor adds a `sprite.width` tweak assuming it changes
  the hitbox, they'll be wrong. Mitigation: docblock on `sprite` store +
  ESLint no-restricted-syntax rule flagging `.stores.sprite.width` /
  `.height` reads outside `src/engine/` and `src/labs/`.

## Alternatives Considered

- **Keep `sprite.width`/`height` as the physics dimension, add `weight`
  consumer only.** Rejected — the user explicitly asked for a "true size
  system", and it perpetuates the render↔physics conflation that Rule #10
  observability keeps rediscovering.
- **Single `Body` component that also carries mass.** Rejected — `Weight`
  already exists and is populated everywhere; a rename churns callers for
  no gain. Keeping Size/Weight as siblings mirrors bitecs' pattern (many
  small components > few fat components).
- **Only circles, no box override.** Rejected — walls, doors, and boss
  encounters have obviously non-circular footprints. The user picked
  "radius + optional box override" from the scope choice.
- **Non-axis-aligned bodies (OBBs, capsules).** Rejected as non-goal for
  this ADR; can be added later behind a `shape=2/3` value.

## References

- ADR 0001 — ECS architecture (component-per-concern rationale)
- ADR 0007 — Spatial units architecture (feet as canonical unit)
- ADR 0023 — Feet as single internal spatial unit
- ADR 0025 — HiDPI supersampling (source of a render↔physics conflation risk)
- Spec: `.specify/specs/entity-physics.md`
- Data table: `docs/knowledge/game-design/entity-sizing.md`
