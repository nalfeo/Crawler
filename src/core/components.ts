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
export const Flying = {};
export const Projectile = {};
/** Marks an entity as an enemy projectile. */
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
/** Projectile that can bounce off arena bounds before despawning. */
export const Bouncing = {};
/** Continuous beam/line damage from this entity's position. */
export const LineDamage = {};
/** Placed trap that arms and triggers on proximity. */
export const Trap = {};
/** Active melee swing — a blade line that sweeps through an arc. */
export const MeleeSwing = {};
/** Smooth knockback impulse — decays over time. */
export const Knockback = {};
/** Dropped gold entity that awards currency on pickup. */
export const Gold = {};
/** Door entity — tracks open/closed state and tile position. */
export const DoorState = {};
/** Marks a dying entity — delays removal so knockback/death animations can play. */
export const DeathTimer = {};
/** Marks an entity as an NPC — non-hostile and tracked in world.npcs sidecar. */
export const Npc = {};
/** Marks an entity as invincible — applyDamage skips it entirely. */
export const Invincible = {};
/** Physical weight of an entity (lbs). Used for knockback, strength interactions, etc. */
export const Weight = {};

// --- Component Stores ---
// Typed array stores for component data. Accessed directly: world.stores.<name>.<field>[eid]
export const DEFAULT_MAX_ENTITIES = 10_000;

/** Creates fresh typed-array stores for all components. */
export function createComponentStores(maxEntities = DEFAULT_MAX_ENTITIES) {
  return {
    position: { x: new Float32Array(maxEntities), y: new Float32Array(maxEntities) },
    velocity: { x: new Float32Array(maxEntities), y: new Float32Array(maxEntities) },
    rotation: { angle: new Float32Array(maxEntities) },
    health: { current: new Float32Array(maxEntities), max: new Float32Array(maxEntities) },
    damage: {
      amount: new Float32Array(maxEntities),
      cooldownMs: new Float32Array(maxEntities),
      lastFireMs: new Float32Array(maxEntities),
    },
    xpGem: { value: new Float32Array(maxEntities) },
    projectile: {
      pierce: new Uint8Array(maxEntities),
      hitCount: new Uint8Array(maxEntities),
      maxRange: new Float32Array(maxEntities),
      originX: new Float32Array(maxEntities),
      originY: new Float32Array(maxEntities),
    },
    sprite: {
      textureId: new Uint16Array(maxEntities),
      width: new Float32Array(maxEntities),
      height: new Float32Array(maxEntities),
    },
    enemyBehavior: {
      type: new Uint8Array(maxEntities),
      speed: new Float32Array(maxEntities),
      aggroRange: new Float32Array(maxEntities),
      attackRange: new Float32Array(maxEntities),
      fireCooldownMs: new Float32Array(maxEntities),
      lastFireMs: new Float32Array(maxEntities),
      persona: new Uint8Array(maxEntities),
      traversalMode: new Uint8Array(maxEntities),
      flankDistance: new Float32Array(maxEntities),
      pathRefreshFrames: new Uint16Array(maxEntities),
      /** Set to 1 when this enemy has been permanently aggroed (e.g. hit by player). */
      aggroedPermanently: new Uint8Array(maxEntities),
      /** Frames since velocity was zero (used to detect stuck enemies). */
      stuckFrames: new Uint16Array(maxEntities),
    },
    broadcastScore: { current: new Float32Array(maxEntities) },
    droppedItem: { itemIndex: new Uint16Array(maxEntities) },
    weapon: {
      weaponType: new Uint8Array(maxEntities),
      baseDamage: new Float32Array(maxEntities),
      cooldownMs: new Float32Array(maxEntities),
      lastFireMs: new Float32Array(maxEntities),
      range: new Float32Array(maxEntities),
      projectileSpeed: new Float32Array(maxEntities),
    },
    owner: {
      eid: new Uint16Array(maxEntities),
    },
    team: {
      id: new Uint8Array(maxEntities),
    },
    lifetime: {
      expiresAtMs: new Float32Array(maxEntities),
    },
    areaDamage: {
      radius: new Float32Array(maxEntities),
      damage: new Float32Array(maxEntities),
      hitOnce: new Uint8Array(maxEntities),
      arcCenterRad: new Float32Array(maxEntities),
      arcHalfRad: new Float32Array(maxEntities),
    },
    aoeOnImpact: {
      radius: new Float32Array(maxEntities),
      damage: new Float32Array(maxEntities),
    },
    returning: {
      returnSpeed: new Float32Array(maxEntities),
      isReturning: new Uint8Array(maxEntities),
      maxRange: new Float32Array(maxEntities),
      originX: new Float32Array(maxEntities),
      originY: new Float32Array(maxEntities),
    },
    bouncing: {
      remainingBounces: new Uint8Array(maxEntities),
    },
    lineDamage: {
      dirX: new Float32Array(maxEntities),
      dirY: new Float32Array(maxEntities),
      length: new Float32Array(maxEntities),
      damage: new Float32Array(maxEntities),
      tickMs: new Float32Array(maxEntities),
      lastTickMs: new Float32Array(maxEntities),
    },
    trap: {
      triggerRadius: new Float32Array(maxEntities),
      explosionRadius: new Float32Array(maxEntities),
      explosionDamage: new Float32Array(maxEntities),
      armAtMs: new Float32Array(maxEntities),
    },
    meleeSwing: {
      bladeLength: new Float32Array(maxEntities),
      arcCenterRad: new Float32Array(maxEntities),
      arcHalfRad: new Float32Array(maxEntities),
      damage: new Float32Array(maxEntities),
      spawnAtMs: new Float32Array(maxEntities),
      durationMs: new Float32Array(maxEntities),
      style: new Uint8Array(maxEntities),
      headRadius: new Float32Array(maxEntities),
      shaftDamageMult: new Float32Array(maxEntities),
      knockback: new Float32Array(maxEntities),
      /** Sprite ID hint: see MELEE_SPRITE_ID in weaponSystem.ts. 0|1=sword, 2=bat. */
      spriteId: new Uint8Array(maxEntities),
    },
    knockback: {
      dirX: new Float32Array(maxEntities),
      dirY: new Float32Array(maxEntities),
      remaining: new Float32Array(maxEntities),
      speed: new Float32Array(maxEntities),
    },
    gold: {
      value: new Float32Array(maxEntities),
    },
    doorState: {
      tileX: new Uint16Array(maxEntities),
      tileY: new Uint16Array(maxEntities),
      isOpen: new Uint8Array(maxEntities), // 0 = closed, 1 = open
      isLocked: new Uint8Array(maxEntities), // 0 = unlocked, 1 = locked
      wasUnlocked: new Uint8Array(maxEntities), // 0 = never unlocked, 1 = unlocked at least once
    },
    deathTimer: {
      remainingMs: new Float32Array(maxEntities),
    },
    npc: {
      /** Index into the NPC registry; used to look up NpcDef. Stored as a compact uint16. */
      defIdIndex: new Uint16Array(maxEntities),
    },
    weight: {
      value: new Float32Array(maxEntities),
    },
    baseStats: {
      strength: new Float32Array(maxEntities),
      dexterity: new Float32Array(maxEntities),
      constitution: new Float32Array(maxEntities),
      intelligence: new Float32Array(maxEntities),
      wisdom: new Float32Array(maxEntities),
      charisma: new Float32Array(maxEntities),
      luck: new Float32Array(maxEntities),
      armor: new Float32Array(maxEntities),
      damageBonus: new Float32Array(maxEntities),
      attackSpeed: new Float32Array(maxEntities),
      moveSpeed: new Float32Array(maxEntities),
      critChance: new Float32Array(maxEntities),
      critMultiplier: new Float32Array(maxEntities),
      dodgeChance: new Float32Array(maxEntities),
      hpRegen: new Float32Array(maxEntities),
      xpBonus: new Float32Array(maxEntities),
      cooldownReduction: new Float32Array(maxEntities),
    },
    effectiveStats: {
      strength: new Float32Array(maxEntities),
      dexterity: new Float32Array(maxEntities),
      constitution: new Float32Array(maxEntities),
      intelligence: new Float32Array(maxEntities),
      wisdom: new Float32Array(maxEntities),
      charisma: new Float32Array(maxEntities),
      luck: new Float32Array(maxEntities),
      armor: new Float32Array(maxEntities),
      damageBonus: new Float32Array(maxEntities),
      attackSpeed: new Float32Array(maxEntities),
      moveSpeed: new Float32Array(maxEntities),
      critChance: new Float32Array(maxEntities),
      critMultiplier: new Float32Array(maxEntities),
      dodgeChance: new Float32Array(maxEntities),
      hpRegen: new Float32Array(maxEntities),
      xpBonus: new Float32Array(maxEntities),
      cooldownReduction: new Float32Array(maxEntities),
    },
    stats: {
      maxHp: new Float32Array(maxEntities),
      moveSpeed: new Float32Array(maxEntities),
      damage: new Float32Array(maxEntities),
      armor: new Float32Array(maxEntities),
      attackSpeed: new Float32Array(maxEntities),
      pickupRange: new Float32Array(maxEntities),
      projectileCount: new Float32Array(maxEntities),
      projectileSpeed: new Float32Array(maxEntities),
    },
    statPoints: {
      maxHp: new Float32Array(maxEntities),
      moveSpeed: new Float32Array(maxEntities),
      damage: new Float32Array(maxEntities),
      armor: new Float32Array(maxEntities),
      attackSpeed: new Float32Array(maxEntities),
      pickupRange: new Float32Array(maxEntities),
      projectileCount: new Float32Array(maxEntities),
      projectileSpeed: new Float32Array(maxEntities),
    },
  };
}

export type ComponentStores = ReturnType<typeof createComponentStores>;
