import { hasComponent, query } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Damage,
  Enemy,
  EnemyBehavior,
  Owner,
  Spawner,
  Velocity,
} from '../../src/core/components.js';
import { spawnSpawner } from '../../src/core/helpers.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from '../../src/game/spawners/registry.js';
import { spawnerSystem } from '../../src/game/spawners/spawnerSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

function makeNest(world: ReturnType<typeof createTestWorld>, x = 100, y = 100): number {
  return spawnSpawner(world, x, y, RATS_NEST.hp, {
    defIndex: RATS_NEST_INDEX,
    contactDamage: RATS_NEST.contactDamage,
  });
}

/** Count children — interval-spawned mobs carry Owner; the spawner itself does not. */
function childCount(world: ReturnType<typeof createTestWorld>): number {
  return query(world.ecs, [Enemy, Owner]).length;
}

describe('spawnSpawner', () => {
  it('creates an immobile enemy: no Velocity, no EnemyBehavior, but tagged Spawner', () => {
    const world = createTestWorld();
    const nest = makeNest(world);

    expect(hasComponent(world.ecs, nest, Enemy)).toBe(true);
    expect(hasComponent(world.ecs, nest, Spawner)).toBe(true);
    expect(hasComponent(world.ecs, nest, Velocity)).toBe(false);
    expect(hasComponent(world.ecs, nest, EnemyBehavior)).toBe(false);
    expect(world.stores.health.max[nest]).toBe(RATS_NEST.hp);
    expect(world.stores.spawner.mode[nest]).toBe(0);
  });
});

describe('spawnerSystem — passive mode', () => {
  it('spawns on its interval and never exceeds the passive cap', () => {
    const world = createTestWorld();
    makeNest(world);

    for (let i = 0; i < 30; i += 1) {
      spawnerSystem(world);
      world.elapsedMs += RATS_NEST.passive.intervalMs;
    }

    expect(childCount(world)).toBe(RATS_NEST.passive.maxAlive);
  });

  it('does not spawn again until the interval elapses', () => {
    const world = createTestWorld();
    makeNest(world);

    spawnerSystem(world); // first pulse at t=0
    const afterFirst = childCount(world);
    expect(afterFirst).toBe(1);

    // Advance less than one interval — no new spawn.
    world.elapsedMs += RATS_NEST.passive.intervalMs - 1;
    spawnerSystem(world);
    expect(childCount(world)).toBe(afterFirst);

    // Cross the interval boundary — one more spawn.
    world.elapsedMs += 1;
    spawnerSystem(world);
    expect(childCount(world)).toBe(afterFirst + 1);
  });

  it('tags children with Owner pointing at the spawner and gives them contact Damage', () => {
    const world = createTestWorld();
    const nest = makeNest(world);

    spawnerSystem(world);
    const child = query(world.ecs, [Enemy, Owner])[0]!;

    expect(world.stores.owner.eid[child]).toBe(nest);
    expect(hasComponent(world.ecs, child, Damage)).toBe(true);
    expect(world.stores.damage.amount[child]).toBeGreaterThan(0);
    // Children are mobile (steered by enemyAISystem), unlike the nest.
    expect(hasComponent(world.ecs, child, EnemyBehavior)).toBe(true);
  });

  it('refills as children die, holding the cap', () => {
    const world = createTestWorld();
    makeNest(world);

    for (let i = 0; i < 20; i += 1) {
      spawnerSystem(world);
      world.elapsedMs += RATS_NEST.passive.intervalMs;
    }
    expect(childCount(world)).toBe(RATS_NEST.passive.maxAlive);

    // Kill one child (HP to 0) — it should no longer count, freeing a slot.
    const child = query(world.ecs, [Enemy, Owner])[0]!;
    world.stores.health.current[child] = 0;

    world.elapsedMs += RATS_NEST.passive.intervalMs;
    spawnerSystem(world);

    // One dead + cap living again (a fresh one took the freed slot).
    const living = query(world.ecs, [Enemy, Owner]).filter(
      (e) => (world.stores.health.current[e] ?? 0) > 0,
    );
    expect(living.length).toBe(RATS_NEST.passive.maxAlive);
  });
});

describe('spawnerSystem — defensive mode', () => {
  it('latches into defensive mode the moment the player damages it', () => {
    const world = createTestWorld();
    const nest = makeNest(world);
    expect(world.stores.spawner.mode[nest]).toBe(0);

    world.stores.health.current[nest] = RATS_NEST.hp - 1;
    spawnerSystem(world);

    expect(world.stores.spawner.mode[nest]).toBe(1);
  });

  it('stays enraged even if HP is later restored', () => {
    const world = createTestWorld();
    const nest = makeNest(world);

    world.stores.health.current[nest] = RATS_NEST.hp - 1;
    spawnerSystem(world);
    world.stores.health.current[nest] = RATS_NEST.hp; // "heal" back to full
    world.elapsedMs += RATS_NEST.defensive.intervalMs;
    spawnerSystem(world);

    expect(world.stores.spawner.mode[nest]).toBe(1);
  });

  it('spawns the higher defensive perPulse count', () => {
    const world = createTestWorld();
    const nest = makeNest(world);

    // Force defensive and make a pulse due immediately.
    world.stores.spawner.mode[nest] = 1;
    world.stores.spawner.nextSpawnMs[nest] = 0;
    spawnerSystem(world);

    expect(childCount(world)).toBe(RATS_NEST.defensive.perPulse);
    expect(RATS_NEST.defensive.perPulse).toBeGreaterThan(RATS_NEST.passive.perPulse);
  });
});

describe('spawnerSystem — on death', () => {
  it('emits the finale wave exactly once when destroyed', () => {
    const world = createTestWorld();
    const nest = makeNest(world);

    const expectedFinale = RATS_NEST.onDeath.reduce((sum, group) => sum + group.count, 0);
    const before = query(world.ecs, [Enemy]).length; // just the nest

    world.stores.health.current[nest] = 0;
    spawnerSystem(world);

    const afterFirst = query(world.ecs, [Enemy]).length;
    expect(afterFirst - before).toBe(expectedFinale);
    expect(world.stores.spawner.deathResolved[nest]).toBe(1);

    // A dead spawner must not keep spawning on subsequent ticks.
    spawnerSystem(world);
    spawnerSystem(world);
    expect(query(world.ecs, [Enemy]).length).toBe(afterFirst);
  });

  it('spawns exactly one monarch (king or queen) among the finale', () => {
    const world = createTestWorld();
    const nest = makeNest(world);

    world.stores.health.current[nest] = 0;
    spawnerSystem(world);

    // Finale children carry no Owner; the monarch is the only high-HP mob.
    const finale = query(world.ecs, [Enemy]).filter((e) => e !== nest);
    const monarchs = finale.filter((e) => (world.stores.health.max[e] ?? 0) >= 80);
    const rats = finale.filter((e) => (world.stores.health.max[e] ?? 0) === 8);
    expect(monarchs.length).toBe(1);
    expect(rats.length).toBe(3);
  });
});

describe('spawnerSystem — determinism', () => {
  function fingerprint(seed: number): string {
    const world = createTestWorld({ seed });
    makeNest(world);
    for (let i = 0; i < 12; i += 1) {
      spawnerSystem(world);
      world.elapsedMs += RATS_NEST.passive.intervalMs;
    }
    const children = Array.from(query(world.ecs, [Enemy, Owner]))
      .map(
        (e) =>
          `${world.stores.position.x[e]?.toFixed(3)},${world.stores.position.y[e]?.toFixed(3)}`,
      )
      .sort();
    return `${children.length}|${children.join(';')}`;
  }

  it('produces identical results for the same seed', () => {
    expect(fingerprint(7)).toBe(fingerprint(7));
  });

  it('differs across seeds', () => {
    expect(fingerprint(7)).not.toBe(fingerprint(99));
  });
});
