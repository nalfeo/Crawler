import { addComponent, addEntity, set } from 'bitecs';
import { createInventoryBag } from '../shared/inventory.js';
import {
  AoeOnImpact,
  Bouncing,
  AreaDamage,
  BloodColor,
  Damage,
  Enemy,
  EnemyBehavior,
  EnemyProjectile,
  Flying,
  Gold,
  Health,
  Inventory,
  Invincible,
  Lifetime,
  LineDamage,
  MeleeSwing,
  Npc,
  Owner,
  Player,
  Position,
  Projectile,
  Returning,
  Sprite,
  Spawner,
  Team,
  Trap,
  Velocity,
  Weapon,
  Weight,
  XpGem,
  DroppedItem,
} from './components.js';
import type { GameWorld } from './world.js';
import type { WeaponTypeValue } from '../shared/constants.js';
import { PATH_PERSONA, TRAVERSAL_MODE } from '../shared/enemy-behavior.js';
import { clearAreaDamageHits } from './systems/areaDamageSystem.js';
import { clearMeleeSwingHits } from './systems/meleeSwingSystem.js';
import { getNpcDef, type NpcInstance } from '../shared/npc-types.js';

// Re-export applyDamage for backward compatibility
export { applyDamage } from './apply-damage.js';

/** Zero all typed-array store slots for a recycled entity ID. */
export function clearEntityStores(world: GameWorld, eid: number): void {
  const { stores } = world;
  for (const group of Object.values(stores)) {
    for (const arr of Object.values(group as Record<string, ArrayLike<number>>)) {
      if (arr instanceof Float32Array || arr instanceof Uint16Array || arr instanceof Uint8Array) {
        arr[eid] = 0;
      }
    }
  }
}

/** Create an entity with zeroed store slots (safe against ID recycling). */
export function createEntity(world: GameWorld): number {
  const eid = addEntity(world.ecs);
  clearEntityStores(world, eid);
  return eid;
}

/** Default blood colour for any enemy that does not specify one (red). */
export const DEFAULT_BLOOD_COLOR = 0xcc0000;

/**
 * Set the BloodColor component from a packed 0xRRGGBB integer.
 * Exported so floor scenarios and other spawners can reuse it.
 */
export function setBloodColor(world: GameWorld, eid: number, hex: number): void {
  addComponent(
    world.ecs,
    eid,
    set(BloodColor, { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff }),
  );
}

export function spawnPlayer(world: GameWorld, x: number, y: number, weight = 180): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: 100, max: 100 }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 3, height: 3 }));
  addComponent(world.ecs, eid, set(Weight, { value: weight }));
  addComponent(world.ecs, eid, Player);
  addComponent(world.ecs, eid, Inventory);
  world.inventories.set(eid, createInventoryBag());

  return eid;
}

export function spawnEnemy(
  world: GameWorld,
  x: number,
  y: number,
  hp: number,
  weight = 120,
  bloodColorHex = DEFAULT_BLOOD_COLOR,
): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: hp, max: hp }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 2, height: 2 }));
  addComponent(world.ecs, eid, set(Weight, { value: weight }));
  addComponent(world.ecs, eid, Enemy);
  setBloodColor(world, eid, bloodColorHex);

  return eid;
}

export function spawnBehaviorEnemy(
  world: GameWorld,
  x: number,
  y: number,
  hp: number,
  behaviorType: number,
  speed: number,
  aggroRange: number,
  attackRange: number,
  options?: {
    persona?: number;
    traversalMode?: number;
    flankDistance?: number;
    pathRefreshFrames?: number;
    isFlying?: boolean;
    weight?: number;
    bloodColor?: number;
  },
): number {
  const eid = createEntity(world);
  const traversalMode = options?.traversalMode ?? TRAVERSAL_MODE.GROUND;
  const isFlying = options?.isFlying === true || traversalMode === TRAVERSAL_MODE.FLYING;

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: hp, max: hp }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 2, height: 2 }));
  addComponent(world.ecs, eid, set(Weight, { value: options?.weight ?? 120 }));
  addComponent(world.ecs, eid, Enemy);
  addComponent(
    world.ecs,
    eid,
    set(EnemyBehavior, {
      type: behaviorType,
      speed,
      aggroRange,
      attackRange,
      persona: options?.persona ?? PATH_PERSONA.NAVIGATOR,
      traversalMode,
      flankDistance: options?.flankDistance ?? 12,
      pathRefreshFrames: options?.pathRefreshFrames ?? 10,
    }),
  );
  if (isFlying) {
    addComponent(world.ecs, eid, Flying);
  }
  setBloodColor(world, eid, options?.bloodColor ?? DEFAULT_BLOOD_COLOR);

  return eid;
}

/** Options for {@link spawnSpawner}. */
export interface SpawnSpawnerOptions {
  /** Index into the SPAWNER_ARCHETYPES registry that drives this spawner. */
  defIndex: number;
  /** Contact damage dealt to the player on touch (0 disables it). Default 0. */
  contactDamage?: number;
  /** Physical weight in lbs. Default 200 (a heavy, immobile structure). */
  weight?: number;
  /** Blood/ichor colour as packed 0xRRGGBB. Default red. */
  bloodColor?: number;
  /** Sprite texture id. Default 0. */
  textureId?: number;
  /** Sprite width in px. Default 24. */
  spriteWidth?: number;
  /** Sprite height in px. Default 24. */
  spriteHeight?: number;
  /** Extra delay (ms) before the first spawn pulse is allowed. Default 0. */
  initialDelayMs?: number;
}

/**
 * Spawn an immobile Spawner enemy — a structure that periodically spits out
 * other mobs (see `spawnerSystem` + the SPAWNER_ARCHETYPES registry).
 *
 * Deliberately has NO Velocity and NO EnemyBehavior, so it is ignored by
 * movementSystem and enemyAISystem and stays put. It still has Position +
 * Sprite, so collisionSystem registers contact hits (the player can walk into
 * it and take `contactDamage`, and player attacks can destroy it).
 */
export function spawnSpawner(
  world: GameWorld,
  x: number,
  y: number,
  hp: number,
  options: SpawnSpawnerOptions,
): number {
  const eid = createEntity(world);
  const contactDamage = options.contactDamage ?? 0;

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Health, { current: hp, max: hp }));
  addComponent(
    world.ecs,
    eid,
    set(Sprite, {
      textureId: options.textureId ?? 0,
      width: options.spriteWidth ?? 24,
      height: options.spriteHeight ?? 24,
    }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: options.weight ?? 200 }));
  addComponent(world.ecs, eid, Enemy);
  addComponent(
    world.ecs,
    eid,
    set(Spawner, {
      defIndex: Math.max(0, Math.floor(options.defIndex)),
      mode: 0,
      nextSpawnMs: world.elapsedMs + Math.max(0, options.initialDelayMs ?? 0),
      spawnedTotal: 0,
      deathResolved: 0,
    }),
  );
  if (contactDamage > 0) {
    addComponent(
      world.ecs,
      eid,
      set(Damage, { amount: contactDamage, cooldownMs: 0, lastFireMs: 0 }),
    );
  }
  setBloodColor(world, eid, options.bloodColor ?? DEFAULT_BLOOD_COLOR);

  return eid;
}

export function spawnXpGem(
  world: GameWorld,
  x: number,
  y: number,
  value: number,
  weight = 1,
): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(XpGem, { value }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 1, height: 1 }));
  addComponent(world.ecs, eid, set(Weight, { value: weight }));

  return eid;
}

export function spawnGold(
  world: GameWorld,
  x: number,
  y: number,
  value: number,
  weight = 1,
): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Gold, { value }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 1, height: 1 }));
  addComponent(world.ecs, eid, set(Weight, { value: weight }));

  return eid;
}

export function spawnProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  pierce: number = 0,
  maxRange: number = 0,
  weight: number = 1,
  ownerEid?: number,
): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: vx, y: vy }));
  addComponent(world.ecs, eid, set(Damage, { amount: damage, cooldownMs: 0, lastFireMs: 0 }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 0.75, height: 0.75 }));
  addComponent(
    world.ecs,
    eid,
    set(Projectile, { pierce, hitCount: 0, maxRange, originX: x, originY: y }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: weight }));
  if (ownerEid !== undefined) {
    addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  }

  return eid;
}

export function spawnEnemyProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
): number {
  const eid = spawnProjectile(world, x, y, vx, vy, damage);
  addComponent(world.ecs, eid, EnemyProjectile);
  return eid;
}

export function spawnDroppedItem(
  world: GameWorld,
  x: number,
  y: number,
  itemIndex: number,
  weight = 5,
): number {
  const eid = createEntity(world);
  const sanitizedItemIndex = Math.max(0, Math.min(0xffff, Math.floor(itemIndex)));

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(DroppedItem, { itemIndex: sanitizedItemIndex }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 1.25, height: 1.25 }));
  addComponent(world.ecs, eid, set(Weight, { value: weight }));

  return eid;
}

/** Spawn a weapon entity attached to an owner. */
export function spawnWeapon(
  world: GameWorld,
  ownerEid: number,
  weaponType: WeaponTypeValue,
  baseDamage: number,
  cooldownMs: number,
  range: number,
  projectileSpeed: number,
  teamId: number,
): number {
  const eid = createEntity(world);
  addComponent(
    world.ecs,
    eid,
    set(Weapon, {
      weaponType,
      baseDamage,
      cooldownMs,
      lastFireMs: -cooldownMs,
      range,
      projectileSpeed,
    }),
  );
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  return eid;
}

/** Spawn a melee/unarmed area attack at the player's position. */
export function spawnAreaAttack(
  world: GameWorld,
  x: number,
  y: number,
  ownerEid: number,
  damage: number,
  radius: number,
  durationMs: number,
  teamId: number,
  dirX?: number,
  dirY?: number,
  arcDeg?: number,
): number {
  const eid = createEntity(world);
  const hasArc =
    dirX !== undefined && dirY !== undefined && arcDeg !== undefined && arcDeg > 0 && arcDeg < 360;
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(AreaDamage, {
      radius,
      damage,
      hitOnce: 1,
      arcCenterRad: hasArc ? Math.atan2(dirY, dirX) : 0,
      arcHalfRad: hasArc ? (arcDeg / 2) * (Math.PI / 180) : 0,
    }),
  );
  // Clear stale hit tracking in case this entity ID was recycled.
  clearAreaDamageHits(world, eid);
  addComponent(world.ecs, eid, set(Lifetime, { expiresAtMs: world.elapsedMs + durationMs }));
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(
    world.ecs,
    eid,
    set(Sprite, { textureId: 0, width: radius * 2, height: radius * 2 }),
  );
  return eid;
}

/** Spawn a projectile that explodes into AoE on impact. */
export function spawnAoeProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  aoeRadius: number,
  aoeDamage: number,
  ownerEid: number,
  teamId: number,
  maxRange: number = 0,
): number {
  const eid = spawnProjectile(world, x, y, vx, vy, damage, 0, maxRange);
  addComponent(world.ecs, eid, set(AoeOnImpact, { radius: aoeRadius, damage: aoeDamage }));
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  return eid;
}

/** Spawn a returning/boomerang projectile. */
export function spawnReturningProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  ownerEid: number,
  returnSpeed: number,
  maxRange: number,
  teamId: number,
  pierce: number = 0,
): number {
  const eid = spawnProjectile(world, x, y, vx, vy, damage, pierce);
  addComponent(
    world.ecs,
    eid,
    set(Returning, {
      returnSpeed,
      isReturning: 0,
      maxRange,
      originX: x,
      originY: y,
    }),
  );
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  return eid;
}

/** Spawn a projectile that can bounce off arena bounds. */
export function spawnBouncingProjectile(
  world: GameWorld,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  remainingBounces: number,
  pierce: number = 0,
  maxRange: number = 0,
  ownerEid?: number,
): number {
  const eid = spawnProjectile(world, x, y, vx, vy, damage, pierce, maxRange, 1, ownerEid);
  addComponent(world.ecs, eid, set(Bouncing, { remainingBounces }));
  return eid;
}

/** Spawn a beam/line-damage entity. */
export function spawnBeam(
  world: GameWorld,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  length: number,
  damage: number,
  durationMs: number,
  tickMs: number,
  ownerEid: number,
  teamId: number,
): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(LineDamage, { dirX, dirY, length, damage, tickMs, lastTickMs: world.elapsedMs - tickMs }),
  );
  addComponent(world.ecs, eid, set(Lifetime, { expiresAtMs: world.elapsedMs + durationMs }));
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: length, height: 0.5 }));
  return eid;
}

/** Spawn a trap entity at a position. */
export function spawnTrap(
  world: GameWorld,
  x: number,
  y: number,
  explosionDamage: number,
  triggerRadius: number,
  explosionRadius: number,
  armDelayMs: number,
  ownerEid: number,
  teamId: number,
): number {
  const eid = createEntity(world);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(Trap, {
      triggerRadius,
      explosionRadius,
      explosionDamage,
      armAtMs: world.elapsedMs + armDelayMs,
    }),
  );
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 1.5, height: 1.5 }));
  return eid;
}

/** Spawn a melee swing entity — a blade that sweeps through an arc or thrusts forward. */
export function spawnMeleeSwing(
  world: GameWorld,
  x: number,
  y: number,
  ownerEid: number,
  damage: number,
  bladeLength: number,
  durationMs: number,
  dirX: number,
  dirY: number,
  arcDeg: number,
  teamId: number,
  style: number = 0,
  headRadius: number = 0,
  shaftDamageMult: number = 1,
  knockback: number = 0,
  spriteId: number = 0,
): number {
  const eid = createEntity(world);
  const arcCenterRad = Math.atan2(dirY, dirX);
  const arcHalfRad = (arcDeg / 2) * (Math.PI / 180);
  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(MeleeSwing, {
      bladeLength,
      arcCenterRad,
      arcHalfRad,
      damage,
      spawnAtMs: world.elapsedMs,
      durationMs,
      style,
      headRadius,
      shaftDamageMult,
      knockback,
      spriteId,
    }),
  );
  // Clear any stale hit tracking from a recycled entity ID
  clearMeleeSwingHits(world, eid);
  addComponent(world.ecs, eid, set(Lifetime, { expiresAtMs: world.elapsedMs + durationMs }));
  addComponent(world.ecs, eid, set(Owner, { eid: ownerEid }));
  addComponent(world.ecs, eid, set(Team, { id: teamId }));
  addComponent(
    world.ecs,
    eid,
    set(Sprite, { textureId: 0, width: bladeLength * 2, height: bladeLength * 2 }),
  );
  return eid;
}

/**
 * Spawn an NPC entity at the given position.
 * NPCs are non-hostile (no Enemy component) and invincible by default.
 * The defId must match a registered NpcDef in npc-types.ts.
 * Returns the entity id, or -1 if the defId is not found.
 */
export function spawnNpc(world: GameWorld, x: number, y: number, defId: string): number {
  const def = getNpcDef(defId);
  if (def === undefined) {
    return -1;
  }

  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(
    world.ecs,
    eid,
    set(Sprite, { textureId: def.textureId, width: def.widthFt, height: def.heightFt }),
  );
  addComponent(world.ecs, eid, set(Npc, { defIdIndex: 0 }));
  addComponent(world.ecs, eid, Invincible);

  const instance: NpcInstance = {
    defId,
    dialogueIndex: 0,
    quests: def.quests.map((q) => ({ questId: q.questId, status: 'available' })),
    nearbyPlayer: false,
  };
  world.npcs.set(eid, instance);

  return eid;
}
