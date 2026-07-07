/**
 * Spawner System — drives the generic Spawner mob-type.
 *
 * For every entity carrying the {@link Spawner} component this system:
 *  1. **On death** — when the structure's HP hits 0, emits its one-shot finale
 *     wave (e.g. a Rat King/Queen or a Mama/Papa Slime plus stragglers). The
 *     spawner lingers via DeathTimer, so it is still present when we detect this.
 *  2. **Defensive enrage** — the first time the player damages it (HP < max) the
 *     spawner latches into defensive mode (faster interval, higher cap, harder
 *     pool). It never relaxes back to passive.
 *  3. **Passive/defensive spawning** — on a fixed interval, while under the
 *     mode's concurrent cap, spawns `perPulse` mobs picked from the active pool.
 *
 * Concurrent children are tracked with the shared {@link Owner} component
 * (child.owner == spawnerEid), so the cap is per-spawner and deterministic.
 *
 * All randomness flows through `world.rng`, so playthroughs stay seed-stable.
 * Run it once per fixed step alongside the other enemy systems (after
 * enemyAISystem is a natural slot).
 */
import { addComponent, hasComponent, query, set, setComponent } from 'bitecs';
import {
  Damage,
  DeathTimer,
  Enemy,
  Health,
  Owner,
  Player,
  Position,
  SpawnAnim,
  Spawner,
  Size,
  Sprite,
} from '../../core/components.js';
import { setEnemyAppearanceKey, spawnBehaviorEnemy } from '../../core/helpers.js';
import { SHAPE_CIRCLE } from '../../core/physics-defs.js';
import type { GameWorld } from '../../core/world.js';
import { createLogger } from '../../shared/logger.js';
import { pushVfxEvent } from '../../shared/vfx-events.js';
import { getSpawnerArchetypeByIndex, pickFromPool } from './registry.js';
import type { MobTemplate, SpawnMode } from './types.js';

const logger = createLogger('game:spawner');

/** Children appear in a ring this many feet from the spawner's centre. */
const CHILD_SPAWN_RADIUS_MIN = 2;
const CHILD_SPAWN_RADIUS_MAX = 5;
const SPAWNER_CHILD_SPAWN_ANIM_MS = 240;
const SPAWNER_CHILD_CHASE_DELAY_MIN_MS = 250;
const SPAWNER_CHILD_CHASE_DELAY_MAX_MS = 500;
const SPAWNER_OPPOSITE_SPAWN_HALF_ANGLE_RAD = Math.PI / 4;
const SPAWNER_PULSE_COLOR = 0x9be15d;

const SPAWN_MODE = { PASSIVE: 0, DEFENSIVE: 1 } as const;

function emitSpawnerPulse(world: GameWorld, x: number, y: number, intensity: number): void {
  pushVfxEvent(world.vfxEvents, {
    kind: 'spawnerPulse',
    x,
    y,
    color: SPAWNER_PULSE_COLOR,
    intensity: Math.max(0.8, intensity),
  });
}

/** Count living, non-dying children owned by a given spawner. */
function countAliveChildren(world: GameWorld, spawnerEid: number): number {
  const children = query(world.ecs, [Enemy, Owner]);
  const { owner, health } = world.stores;
  let count = 0;

  for (const child of children) {
    if (owner.eid[child] !== spawnerEid) continue;
    if ((health.current[child] ?? 0) <= 0) continue;
    if (hasComponent(world.ecs, child, DeathTimer)) continue;
    count += 1;
  }

  return count;
}

/**
 * Spawn one mob from a template near the spawner. When `link` is true the child
 * is tagged with Owner so it counts against the spawner's concurrent cap
 * (used for interval spawns, not for the on-death finale).
 */
function spawnChild(
  world: GameWorld,
  spawnerEid: number,
  originX: number,
  originY: number,
  mob: MobTemplate,
  link: boolean,
  playerX?: number,
  playerY?: number,
): number {
  const angle =
    playerX !== undefined && playerY !== undefined
      ? (() => {
          const towardPlayer = Math.atan2(playerY - originY, playerX - originX);
          const opposite = towardPlayer + Math.PI;
          const jitter = (world.rng.next() * 2 - 1) * SPAWNER_OPPOSITE_SPAWN_HALF_ANGLE_RAD;
          return opposite + jitter;
        })()
      : world.rng.next() * Math.PI * 2;
  const distance =
    CHILD_SPAWN_RADIUS_MIN + world.rng.next() * (CHILD_SPAWN_RADIUS_MAX - CHILD_SPAWN_RADIUS_MIN);
  const x = originX + Math.cos(angle) * distance;
  const y = originY + Math.sin(angle) * distance;

  const eid = spawnBehaviorEnemy(
    world,
    x,
    y,
    mob.hp,
    mob.aiType,
    mob.speed,
    mob.aggroRange,
    mob.attackRange,
    {
      traversalMode: mob.traversalMode,
      isFlying: mob.isFlying,
      weight: mob.weight,
      bloodColor: mob.bloodColor,
      persona: mob.persona,
      aggroEnableAtMs:
        world.elapsedMs +
        (SPAWNER_CHILD_CHASE_DELAY_MIN_MS +
          world.rng.next() * (SPAWNER_CHILD_CHASE_DELAY_MAX_MS - SPAWNER_CHILD_CHASE_DELAY_MIN_MS)),
    },
  );

  setComponent(world.ecs, eid, Sprite, {
    textureId: mob.textureId,
    width: mob.spriteWidth,
    height: mob.spriteHeight,
  });
  setComponent(world.ecs, eid, Size, {
    // Slice-1 rule: body half-extent equals sprite half-extent for the mob
    // template so `collision-pair-parity` stays green. Slice 2+ can bring in
    // explicit body fields on `MobTemplate`.
    radius: Math.max(mob.spriteWidth, mob.spriteHeight) * 0.5,
    halfWidth: 0,
    halfHeight: 0,
    shape: SHAPE_CIRCLE,
  });
  setEnemyAppearanceKey(world, eid, mob.id);
  addComponent(
    world.ecs,
    eid,
    set(SpawnAnim, {
      remainingMs: SPAWNER_CHILD_SPAWN_ANIM_MS,
      totalMs: SPAWNER_CHILD_SPAWN_ANIM_MS,
    }),
  );

  if (mob.contactDamage > 0) {
    addComponent(
      world.ecs,
      eid,
      set(Damage, { amount: mob.contactDamage, cooldownMs: 0, lastFireMs: 0 }),
    );
  }

  if (link) {
    addComponent(world.ecs, eid, set(Owner, { eid: spawnerEid }));
  }

  return eid;
}

/** Emit a spawner's one-shot on-death finale wave. */
function resolveDeathFinale(
  world: GameWorld,
  spawnerEid: number,
  x: number,
  y: number,
  defIndex: number,
  playerX?: number,
  playerY?: number,
): void {
  const def = getSpawnerArchetypeByIndex(defIndex);
  if (def === undefined) return;
  let spawned = 0;

  for (const group of def.onDeath) {
    for (let i = 0; i < group.count; i += 1) {
      const mob = pickFromPool(group.pool, world.rng.next());
      if (mob !== undefined) {
        spawnChild(world, spawnerEid, x, y, mob, false, playerX, playerY);
        spawned += 1;
      }
    }
  }

  if (spawned > 0) {
    emitSpawnerPulse(world, x, y, 1 + spawned / 5);
  }

  logger.info('Spawner death finale emitted', { eid: spawnerEid, archetype: def.id });
}

export function spawnerSystem(world: GameWorld): void {
  const spawners = query(world.ecs, [Spawner, Position, Health]);
  const players = query(world.ecs, [Player, Position]);
  const { spawner, position, health } = world.stores;
  const playerEid = players[0];
  const playerX = playerEid !== undefined ? position.x[playerEid] : undefined;
  const playerY = playerEid !== undefined ? position.y[playerEid] : undefined;

  for (const eid of spawners) {
    if (eid === undefined) continue;

    const defIndex = spawner.defIndex[eid] ?? 0;
    const def = getSpawnerArchetypeByIndex(defIndex);
    if (def === undefined) continue;

    const x = position.x[eid] ?? 0;
    const y = position.y[eid] ?? 0;
    const hp = health.current[eid] ?? 0;
    const maxHp = health.max[eid] ?? hp;

    // (1) On-death finale — fire exactly once while the corpse lingers.
    if (hp <= 0) {
      if ((spawner.deathResolved[eid] ?? 0) === 0) {
        resolveDeathFinale(world, eid, x, y, defIndex, playerX, playerY);
        spawner.deathResolved[eid] = 1;
      }
      continue;
    }

    // (2) Defensive enrage latch — the moment the player chips its HP.
    if ((spawner.mode[eid] ?? 0) === SPAWN_MODE.PASSIVE && hp < maxHp) {
      spawner.mode[eid] = SPAWN_MODE.DEFENSIVE;
      logger.info('Spawner enraged', { eid, archetype: def.id });
    }

    // (3) Interval spawning, gated by the active mode's cap.
    const mode: SpawnMode =
      (spawner.mode[eid] ?? 0) === SPAWN_MODE.DEFENSIVE ? def.defensive : def.passive;

    if (world.elapsedMs < (spawner.nextSpawnMs[eid] ?? 0)) continue;

    const alive = countAliveChildren(world, eid);
    const room = mode.maxAlive - alive;
    if (room > 0) {
      const pulse = Math.min(mode.perPulse, room);
      let spawned = 0;
      for (let i = 0; i < pulse; i += 1) {
        const mob = pickFromPool(mode.pool, world.rng.next());
        if (mob !== undefined) {
          spawnChild(world, eid, x, y, mob, true, playerX, playerY);
          spawner.spawnedTotal[eid] = (spawner.spawnedTotal[eid] ?? 0) + 1;
          spawned += 1;
        }
      }
      if (spawned > 0) {
        emitSpawnerPulse(world, x, y, 1 + (spawned - 1) * 0.2);
      }
    }

    spawner.nextSpawnMs[eid] = world.elapsedMs + mode.intervalMs;
  }
}
