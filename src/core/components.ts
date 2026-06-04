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
  };
}

export type ComponentStores = ReturnType<typeof createComponentStores>;
