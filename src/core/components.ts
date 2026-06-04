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
export const Inventory = {};
export const Sprite = {};
export const BroadcastScore = {};
export const Equipment = {};
export const BaseStats = {};
export const EffectiveStats = {};
/** Tag: entity has computed final stats (typically player only in v1). */
export const Stats = {};
/** Tag: entity has a skill set (player only in v1). */
export const SkillHolder = {};

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
    droppedItem: { itemIndex: new Uint16Array(MAX_ENTITIES) },
    baseStats: {
      strength: new Float32Array(MAX_ENTITIES),
      dexterity: new Float32Array(MAX_ENTITIES),
      constitution: new Float32Array(MAX_ENTITIES),
      intelligence: new Float32Array(MAX_ENTITIES),
      wisdom: new Float32Array(MAX_ENTITIES),
      charisma: new Float32Array(MAX_ENTITIES),
      luck: new Float32Array(MAX_ENTITIES),
      armor: new Float32Array(MAX_ENTITIES),
      damageBonus: new Float32Array(MAX_ENTITIES),
      attackSpeed: new Float32Array(MAX_ENTITIES),
      moveSpeed: new Float32Array(MAX_ENTITIES),
      critChance: new Float32Array(MAX_ENTITIES),
      critMultiplier: new Float32Array(MAX_ENTITIES),
      dodgeChance: new Float32Array(MAX_ENTITIES),
      hpRegen: new Float32Array(MAX_ENTITIES),
      xpBonus: new Float32Array(MAX_ENTITIES),
      cooldownReduction: new Float32Array(MAX_ENTITIES),
    },
    effectiveStats: {
      strength: new Float32Array(MAX_ENTITIES),
      dexterity: new Float32Array(MAX_ENTITIES),
      constitution: new Float32Array(MAX_ENTITIES),
      intelligence: new Float32Array(MAX_ENTITIES),
      wisdom: new Float32Array(MAX_ENTITIES),
      charisma: new Float32Array(MAX_ENTITIES),
      luck: new Float32Array(MAX_ENTITIES),
      armor: new Float32Array(MAX_ENTITIES),
      damageBonus: new Float32Array(MAX_ENTITIES),
      attackSpeed: new Float32Array(MAX_ENTITIES),
      moveSpeed: new Float32Array(MAX_ENTITIES),
      critChance: new Float32Array(MAX_ENTITIES),
      critMultiplier: new Float32Array(MAX_ENTITIES),
      dodgeChance: new Float32Array(MAX_ENTITIES),
      hpRegen: new Float32Array(MAX_ENTITIES),
      xpBonus: new Float32Array(MAX_ENTITIES),
      cooldownReduction: new Float32Array(MAX_ENTITIES),
    },
    stats: {
      maxHp: new Float32Array(MAX_ENTITIES),
      moveSpeed: new Float32Array(MAX_ENTITIES),
      damage: new Float32Array(MAX_ENTITIES),
      armor: new Float32Array(MAX_ENTITIES),
      attackSpeed: new Float32Array(MAX_ENTITIES),
      pickupRange: new Float32Array(MAX_ENTITIES),
      projectileCount: new Float32Array(MAX_ENTITIES),
      projectileSpeed: new Float32Array(MAX_ENTITIES),
    },
    statPoints: {
      maxHp: new Float32Array(MAX_ENTITIES),
      moveSpeed: new Float32Array(MAX_ENTITIES),
      damage: new Float32Array(MAX_ENTITIES),
      armor: new Float32Array(MAX_ENTITIES),
      attackSpeed: new Float32Array(MAX_ENTITIES),
      pickupRange: new Float32Array(MAX_ENTITIES),
      projectileCount: new Float32Array(MAX_ENTITIES),
      projectileSpeed: new Float32Array(MAX_ENTITIES),
    },
  };
}

export type ComponentStores = ReturnType<typeof createComponentStores>;
