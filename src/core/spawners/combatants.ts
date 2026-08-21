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
  Size,
  Sprite,
  Spawner,
  Velocity,
  Weight,
} from '../components.js';
import { PHYSICS_BODIES, SHAPE_CIRCLE } from '../physics-defs.js';
import type { GameWorld } from '../world.js';
import { DEFAULT_BLOOD_COLOR, TeamId } from '../../shared/constants.js';
import { PATH_PERSONA, TRAVERSAL_MODE } from '../../shared/enemy-behavior.js';
import { hashStringToSeed, SeededRandom } from '../../shared/random.js';
import { createEntity, setBloodColor } from './entity-core.js';
import {
  TELEGRAPH_MS_UNSET,
  isFloat32SafeNonNegativeTelegraphMs,
} from '../systems/enemyTelegraph.js';

const ENEMY_SIZE_SCALE_MIN = 0.9;
const ENEMY_SIZE_SCALE_MAX = 1.1;

function initializeEnemyAppearance(world: GameWorld, eid: number): void {
  const seed = hashStringToSeed(
    `enemy-appearance:${world.seed}:${eid}:${world.frameCount}:${world.elapsedMs}:` +
      `${world.stores.position.x[eid] ?? 0}:${world.stores.position.y[eid] ?? 0}`,
  );
  const appearanceRng = new SeededRandom(seed);
  const sizeScale =
    ENEMY_SIZE_SCALE_MIN + appearanceRng.next() * (ENEMY_SIZE_SCALE_MAX - ENEMY_SIZE_SCALE_MIN);
  world.stores.sprite.variantRoll[eid] = appearanceRng.next();
  world.stores.sprite.sizeScale[eid] = sizeScale;
  // NOTE(size-weight-slice2): Weight intentionally does NOT scale with the
  // cosmetic sizeScale RNG. Weight is a first-class gameplay dial (knockback
  // denominator) and must reflect the authored value so mob-baseline weights
  // stay predictable. Do not restore the sizeScale multiplier here without
  // updating the win-rate baseline and unit-test pins in
  // tests/unit/core/knockback.weight.test.ts.
}

export function setEnemyAppearanceKey(world: GameWorld, eid: number, key: string): void {
  if (key.length === 0) {
    world.enemyAppearanceKeys.delete(eid);
    return;
  }
  world.enemyAppearanceKeys.set(eid, key);
}

export function spawnPlayer(world: GameWorld, x: number, y: number, weight = 180): number {
  const eid = createEntity(world);

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: 100, max: 100 }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 3, height: 3 }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: PHYSICS_BODIES.player.radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
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
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: PHYSICS_BODIES['mob-baseline'].radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: weight }));
  addComponent(world.ecs, eid, Enemy);
  setBloodColor(world, eid, bloodColorHex);
  initializeEnemyAppearance(world, eid);

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
    aggroEnableAtMs?: number;
    weight?: number;
    bloodColor?: number;
    /**
     * Per-mob override (ms) for the projectile telegraph delay; omit to use
     * the configured/world default. An explicit `0` forces immediate fire
     * with no telegraph for this one mob. See TELEGRAPH_MS_UNSET.
     */
    telegraphMs?: number;
  },
): number {
  const eid = createEntity(world);
  const traversalMode = options?.traversalMode ?? TRAVERSAL_MODE.GROUND;
  const isFlying = options?.isFlying === true || traversalMode === TRAVERSAL_MODE.FLYING;

  addComponent(world.ecs, eid, set(Position, { x, y }));
  addComponent(world.ecs, eid, set(Velocity, { x: 0, y: 0 }));
  addComponent(world.ecs, eid, set(Health, { current: hp, max: hp }));
  addComponent(world.ecs, eid, set(Sprite, { textureId: 0, width: 2, height: 2 }));
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      radius: PHYSICS_BODIES['mob-baseline'].radius,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
    }),
  );
  addComponent(world.ecs, eid, set(Weight, { value: options?.weight ?? 120 }));
  addComponent(world.ecs, eid, Enemy);
  addComponent(
    world.ecs,
    eid,
    set(EnemyBehavior, {
      type: behaviorType,
      speed,
      aggroRange,
      aggroEnableAtMs: options?.aggroEnableAtMs ?? 0,
      attackRange,
      persona: options?.persona ?? PATH_PERSONA.NAVIGATOR,
      traversalMode,
      flankDistance: options?.flankDistance ?? 12,
      pathRefreshFrames: options?.pathRefreshFrames ?? 10,
      // clearEntityStores() zeroes this slot on every createEntity() call
      // (recycled AND brand-new EIDs) — the sentinel MUST be re-asserted here
      // at every spawn, not just once at store-array-creation time. See
      // TELEGRAPH_MS_UNSET in core/systems/enemyTelegraph.ts.
      //
      // Sanitize BEFORE this ever reaches the Float32Array-backed
      // `telegraphMs` store: a tiny nonzero override (e.g. `1e-50`) would
      // silently round to `0` on assignment there, becoming
      // indistinguishable from an intentional "legacy: no telegraph"
      // override once written (regression: copilot-pull-request-reviewer
      // finding). Treat any invalid override (negative, non-finite,
      // Float32-overflowing, or Float32-underflowing-to-zero) as unset so it
      // falls through to the world/constant default at resolve time instead
      // of being stored verbatim.
      telegraphMs:
        options?.telegraphMs !== undefined &&
        isFloat32SafeNonNegativeTelegraphMs(options.telegraphMs)
          ? options.telegraphMs
          : TELEGRAPH_MS_UNSET,
    }),
  );
  if (isFlying) {
    addComponent(world.ecs, eid, Flying);
  }
  setBloodColor(world, eid, options?.bloodColor ?? DEFAULT_BLOOD_COLOR);
  initializeEnemyAppearance(world, eid);

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
  /**
   * Battle-arena radius in feet. Defaults to the archetype's `arenaRadiusFt`;
   * clamped at construction to the {@link SPAWNER_MIN_ARENA_RADIUS_FT} floor.
   * Callers only need to override for tests/labs — production placement uses
   * the archetype default so registry data stays the source of truth.
   */
  arenaRadiusFt?: number;
}

/**
 * Absolute minimum arena radius in feet (spec `Requirements§1`). Any smaller
 * radius could allow melee-range spawners to skip the fence-materialise
 * geometry entirely.
 */
export const SPAWNER_MIN_ARENA_RADIUS_FT = 4;
/** Fallback arena radius (spec `Requirements§1`) used when no archetype value. */
export const SPAWNER_DEFAULT_ARENA_RADIUS_FT = 6;
/**
 * Sentinel written into `spawner.arenaKind` at construction. Resolved to
 * `0` (sealed-room) or `1` (open-fence) by `spawnerArenaSystem` on the first
 * tick that observes a `floorMap`.
 */
export const SPAWNER_ARENA_KIND_UNRESOLVED = 255;

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
  addComponent(
    world.ecs,
    eid,
    set(Size, {
      // Structural spawners aren't scaled through initializeEnemyAppearance,
      // so we mirror the sprite's half-extents here rather than the registry's
      // default 1.5 — a caller may pass a non-default spriteWidth/Height.
      radius: Math.max(options.spriteWidth ?? 3, options.spriteHeight ?? 3) * 0.5,
      halfWidth: 0,
      halfHeight: 0,
      shape: SHAPE_CIRCLE,
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
      arenaRadiusFt: Math.max(
        SPAWNER_MIN_ARENA_RADIUS_FT,
        options.arenaRadiusFt ?? SPAWNER_DEFAULT_ARENA_RADIUS_FT,
      ),
      arenaKind: SPAWNER_ARENA_KIND_UNRESOLVED,
      arenaState: 0,
      bankedXp: 0,
      bankedChildren: 0,
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
