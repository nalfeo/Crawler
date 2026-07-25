# ADR 0064: Generic Weapon Anchors for Mob Sprites

## Status

Accepted

## Date

2026-07-17

## Estimated Complexity

🍎 x 3 — spans sprites pipeline, engine bridge, core world, and two game systems

## Context

Ranged enemies emit projectiles whose origin falls back to the mob's ECS pivot (center of entity)
because generated mob art has no explicit attachment point. This causes the projectile and its
telegraph line to originate from the entity center rather than from a logical weapon/muzzle
position (e.g. tip of a staff, barrel of a gun).

The existing `hold` anchor describes how an item sprite attaches to a **holder** (player's hand),
and `centerOfGravity` is the sprite's visual pivot that aligns with the entity's ECS position.
Neither is suitable as a generic mob weapon-attachment point.

Future enemies may emit projectiles or swing visible melee weapons, so the feature must be generic
rather than projectile-only (`muzzle` would be too narrow).

## Decision

Add an optional `weapon` anchor to the generated sprite pipeline:

1. **Schema layer** (`src/shared/generated-assets.ts`, `src/shared/sprite-anchor.ts`): optional
   `weapon?: SpriteAnchor` on `SpriteAnchors`; optional `weapon` on the manifest `anchors` schema;
   optional `weaponAnchor?: {x,y}` on `GeneratedSpriteEntry`.

2. **Pipeline layer** (`scripts/sprites/`): `postprocess-overrides.ts` stores
   `ManualWeaponAnchorOverride`; `run-pipeline.ts` writes `NN.anchor.weapon.json` per variant;
   `rerun.ts` threads it through postprocess; `approve.ts` reads it into the manifest;
   `scripts/sprites/sidecar/server.ts` exposes `POST /weapon-anchor` and includes the sidecar in store hydration.

3. **World-state bridge** (`src/core/world.ts`): `entityWeaponAnchors: Map<number, {x,y}>` stores
   canonical right-facing world-feet offsets for entities whose generated sprite has an explicit
   weapon anchor. Written by the engine layer; read by game-layer systems. This avoids any
   engine-import in `src/core/` or `src/game/`.

4. **Engine layer** (`src/engine/PhaserBridge.ts`): after resolving a generated enemy texture,
   calls `resolveWeaponAnchorWorldPos(entry, 0, 0, spriteWidthFt, spriteHeightFt, frameW, frameH,
true)` to get the canonical right-facing offset and writes it to `world.entityWeaponAnchors`.
   Cleans up on entity destroy.

5. **Game layer** (`src/core/systems/enemyTelegraph.ts`, `src/game/enemyAISystem.ts`): reads
   `world.entityWeaponAnchors.get(eid)` and applies `(facingRight ? wa.x : -wa.x, wa.y)` to the
   entity pivot to get the actual projectile origin.

### Facing / mirroring

Generated mob art defaults to right-facing. When an entity moves left (`velocity.x < 0`),
the render layer flips the sprite horizontally. The weapon anchor mirrors X using
zero-indexed pixel coordinates (`framePixelWidth - 1 - wpX`). Game systems apply the same logic
by negating X when `velocity.x < 0`.

`entityWeaponAnchors` stores the canonical right-facing offset so callers only need to negate X
when facing left — they never need the pixel coordinate or the COG.

## Consequences

### Positive

- Clean layer separation: engine populates a plain `Map<number, {x,y}>` on `GameWorld`; game/core
  systems read it without any engine import.
- Zero behavioral change for enemies without a weapon anchor (fallback to entity pivot).
- Generic enough for melee enemies: any system can look up `entityWeaponAnchors` for attachment.
- Full round-trip: editor → sidecar → postprocess → approve → manifest → registry → engine.
- 8 deterministic unit tests cover the resolver for all facing/anchor combinations.

### Negative

- PhaserBridge runs weapon-anchor resolution every render frame per visible enemy (minor cost,
  guarded by `waEntry?.weaponAnchor` so it skips immediately when absent).
- Weapon anchor must be re-authored if an enemy's COG moves (art change workflow concern).

### Risks

- No existing enemies have weapon anchors; the feature is inert until an editor operator authors
  one. This reduces risk of regression but delays observable validation.

## Alternatives Considered

1. **Muzzle field (projectile-only)**: Rejected — too narrow; a future melee mob would need a
   different field for the same concept (weapon attachment point).

2. **Store offset directly in ECS component**: Rejected — would require adding a new component just
   for one optional pixel coordinate; `entityWeaponAnchors` is simpler and keeps the same
   lifecycle (exists while the entity's visual exists).

3. **Resolve anchor on every projectile spawn (not cached in world map)**: Rejected — requires the
   game layer to know the sprite variant and frame dimensions, which are engine-layer concerns.
   The cached `entityWeaponAnchors` map keeps this knowledge in the engine while exposing a simple
   interface to the game layer.

4. **Per-entity ECS component written by spawner**: Rejected — spawn happens before texture load;
   the engine cannot guarantee the generated sprite entry is loaded at spawn time.
