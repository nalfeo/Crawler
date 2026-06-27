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
  Position,
  Spawner,
  Sprite,
} from '../../core/components.js';
import { spawnBehaviorEnemy } from '../../core/helpers.js';
import type { GameWorld } from '../../core/world.js';
import { createLogger } from '../../shared/logger.js';
import { getSpawnerArchetypeByIndex, pickFromPool } from './registry.js';
import type { MobTemplate, SpawnMode } from './types.js';

const logger = createLogger('game:spawner');

/** Children appear in a ring this many feet from the spawner's centre. */
const CHILD_SPAWN_RADIUS_MIN = 2;
const CHILD_SPAWN_RADIUS_MAX = 5;

const SPAWN_MODE = { PASSIVE: 0, DEFENSIVE: 1 } as const;

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
): number {
  const angle = world.rng.next() * Math.PI * 2;
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
    },
  );

  setComponent(world.ecs, eid, Sprite, {
    textureId: mob.textureId,
    width: mob.spriteWidth,
    height: mob.spriteHeight,
  });

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
): void {
  const def = getSpawnerArchetypeByIndex(defIndex);
  if (def === undefined) return;

  for (const group of def.onDeath) {
    for (let i = 0; i < group.count; i += 1) {
      const mob = pickFromPool(group.pool, world.rng.next());
      if (mob !== undefined) {
        spawnChild(world, spawnerEid, x, y, mob, false);
      }
    }
  }

  logger.info('Spawner death finale emitted', { eid: spawnerEid, archetype: def.id });
}

export function spawnerSystem(world: GameWorld): void {
  const spawners = query(world.ecs, [Spawner, Position, Health]);
  const { spawner, position, health } = world.stores;

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
        resolveDeathFinale(world, eid, x, y, defIndex);
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
      for (let i = 0; i < pulse; i += 1) {
        const mob = pickFromPool(mode.pool, world.rng.next());
        if (mob !== undefined) {
          spawnChild(world, eid, x, y, mob, true);
          spawner.spawnedTotal[eid] = (spawner.spawnedTotal[eid] ?? 0) + 1;
        }
      }
    }

    spawner.nextSpawnMs[eid] = world.elapsedMs + mode.intervalMs;
  }
}
