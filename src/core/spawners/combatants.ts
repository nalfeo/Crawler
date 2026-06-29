import { addComponent, set } from 'bitecs';
import { createInventoryBag } from '../../shared/inventory.js';
import {
  Damage,
  Enemy,
  EnemyBehavior,
  Flying,
  Health,
  Inventory,
  Player,
  Position,
  Sprite,
  Spawner,
  Velocity,
  Weight,
} from '../components.js';
import type { GameWorld } from '../world.js';
import { DEFAULT_BLOOD_COLOR } from '../../shared/constants.js';
import { PATH_PERSONA, TRAVERSAL_MODE } from '../../shared/enemy-behavior.js';
import { createEntity, setBloodColor } from './entity-core.js';

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
  /** Sprite width in feet. Default 3. */
  spriteWidth?: number;
  /** Sprite height in feet. Default 3. */
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
      width: options.spriteWidth ?? 3,
      height: options.spriteHeight ?? 3,
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
