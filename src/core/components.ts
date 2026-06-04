/**
 * ECS Components — defined using bitecs 0.4.x API.
 *
 * bitecs 0.4 uses an observer-based data model:
 * - Components are plain objects used as keys/tags for the ECS
 * - Data is stored in typed arrays managed by createComponentStores()
 * - Use `addComponent(world.ecs, eid, set(Position, { x: 10, y: 20 }))` to add with data
 * - Use `setComponent(world.ecs, eid, Position, { x: 10 })` to update data
 * - Read data via the store: `world.stores.position.x[eid]`
 *
 * IMPORTANT: Stores are per-world. Call createGameWorld() in beforeEach for fresh state.
 */

// --- Component Tags ---
// These are the component identity objects used with addComponent/query/etc.
export const Position = {};
export const Velocity = {};
export const Rotation = {};
export const Health = {};
export const Damage = {};
export const Player = {};
export const Enemy = {};
export const EnemyBehavior = {};
export const Projectile = {};
export const EnemyProjectile = {};
export const XpGem = {};
export const DroppedItem = {};
export const Sprite = {};
export const BroadcastScore = {};

// --- Weapon System Components ---
/** Marks an entity as a weapon with type, stats, and cooldown tracking. */
export const Weapon = {};
/** Links an entity to its owner (e.g., weapon→player, projectile→player). */
export const Owner = {};
/** Assigns a team to prevent friendly fire. */
export const Team = {};
/** Marks an entity for automatic removal after expiry. */
export const Lifetime = {};
/** Area-of-effect damage centered on this entity's position. */
export const AreaDamage = {};
/** Projectile explodes into AoE on impact. */
export const AoeOnImpact = {};
/** Thrown weapon that returns to owner. */
export const Returning = {};
/** Continuous beam/line damage from this entity's position. */
export const LineDamage = {};
/** Placed trap that arms and triggers on proximity. */
export const Trap = {};
/** Active melee swing — a blade line that sweeps through an arc. */
export const MeleeSwing = {};
/** Smooth knockback impulse — decays over time. */
export const Knockback = {};

// --- Component Stores ---
// Typed array stores for component data. Accessed directly: world.stores.<name>.<field>[eid]
const MAX_ENTITIES = 10_000;

/** Creates fresh typed-array stores for all components. */
export function createComponentStores() {
  return {
    position: { x: new Float32Array(MAX_ENTITIES), y: new Float32Array(MAX_ENTITIES) },
    velocity: { x: new Float32Array(MAX_ENTITIES), y: new Float32Array(MAX_ENTITIES) },
    rotation: { angle: new Float32Array(MAX_ENTITIES) },
    health: { current: new Float32Array(MAX_ENTITIES), max: new Float32Array(MAX_ENTITIES) },
    damage: {
      amount: new Float32Array(MAX_ENTITIES),
      cooldownMs: new Float32Array(MAX_ENTITIES),
      lastFireMs: new Float32Array(MAX_ENTITIES),
    },
    xpGem: { value: new Float32Array(MAX_ENTITIES) },
    sprite: {
      textureId: new Uint16Array(MAX_ENTITIES),
      width: new Float32Array(MAX_ENTITIES),
      height: new Float32Array(MAX_ENTITIES),
    },
    enemyBehavior: {
      type: new Uint8Array(MAX_ENTITIES),
      speed: new Float32Array(MAX_ENTITIES),
      aggroRange: new Float32Array(MAX_ENTITIES),
      attackRange: new Float32Array(MAX_ENTITIES),
      fireCooldownMs: new Float32Array(MAX_ENTITIES),
      lastFireMs: new Float32Array(MAX_ENTITIES),
    },
    broadcastScore: { current: new Float32Array(MAX_ENTITIES) },
    weapon: {
      weaponType: new Uint8Array(MAX_ENTITIES),
      baseDamage: new Float32Array(MAX_ENTITIES),
      cooldownMs: new Float32Array(MAX_ENTITIES),
      lastFireMs: new Float32Array(MAX_ENTITIES),
      range: new Float32Array(MAX_ENTITIES),
      projectileSpeed: new Float32Array(MAX_ENTITIES),
    },
    owner: {
      eid: new Uint16Array(MAX_ENTITIES),
    },
    team: {
      id: new Uint8Array(MAX_ENTITIES),
    },
    lifetime: {
      expiresAtMs: new Float32Array(MAX_ENTITIES),
    },
    areaDamage: {
      radius: new Float32Array(MAX_ENTITIES),
      damage: new Float32Array(MAX_ENTITIES),
      hitOnce: new Uint8Array(MAX_ENTITIES),
      arcCenterRad: new Float32Array(MAX_ENTITIES),
      arcHalfRad: new Float32Array(MAX_ENTITIES),
    },
    aoeOnImpact: {
      radius: new Float32Array(MAX_ENTITIES),
      damage: new Float32Array(MAX_ENTITIES),
    },
    returning: {
      returnSpeed: new Float32Array(MAX_ENTITIES),
      isReturning: new Uint8Array(MAX_ENTITIES),
      maxRange: new Float32Array(MAX_ENTITIES),
      originX: new Float32Array(MAX_ENTITIES),
      originY: new Float32Array(MAX_ENTITIES),
    },
    lineDamage: {
      dirX: new Float32Array(MAX_ENTITIES),
      dirY: new Float32Array(MAX_ENTITIES),
      length: new Float32Array(MAX_ENTITIES),
      damage: new Float32Array(MAX_ENTITIES),
      tickMs: new Float32Array(MAX_ENTITIES),
      lastTickMs: new Float32Array(MAX_ENTITIES),
    },
    trap: {
      triggerRadius: new Float32Array(MAX_ENTITIES),
      explosionRadius: new Float32Array(MAX_ENTITIES),
      explosionDamage: new Float32Array(MAX_ENTITIES),
      armAtMs: new Float32Array(MAX_ENTITIES),
    },
    meleeSwing: {
      bladeLength: new Float32Array(MAX_ENTITIES),
      arcCenterRad: new Float32Array(MAX_ENTITIES),
      arcHalfRad: new Float32Array(MAX_ENTITIES),
      damage: new Float32Array(MAX_ENTITIES),
      spawnAtMs: new Float32Array(MAX_ENTITIES),
      durationMs: new Float32Array(MAX_ENTITIES),
      style: new Uint8Array(MAX_ENTITIES),
      headRadius: new Float32Array(MAX_ENTITIES),
      shaftDamageMult: new Float32Array(MAX_ENTITIES),
      knockback: new Float32Array(MAX_ENTITIES),
    },
    knockback: {
      dirX: new Float32Array(MAX_ENTITIES),
      dirY: new Float32Array(MAX_ENTITIES),
      remaining: new Float32Array(MAX_ENTITIES),
      speed: new Float32Array(MAX_ENTITIES),
    },
  };
}

export type ComponentStores = ReturnType<typeof createComponentStores>;
