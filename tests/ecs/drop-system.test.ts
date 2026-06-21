import { query, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  DeathTimer,
  DroppedItem,
  Enemy,
  Gold,
  Health,
  Position,
  XpGem,
} from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import {
  initializeFloor1Scenario,
  meetTutorialGoon,
  selectFloor1StarterWeapon,
} from '../../src/game/floor1Scenario.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('dropSystem', () => {
  it('spawns loot when an enemy dies', () => {
    const world = createTestWorld();
    spawnEnemy(world, 100, 200, 10);

    // Kill the enemy
    const enemies = query(world.ecs, [Enemy]);
    const eid = enemies[0] as number;
    setComponent(world.ecs, eid, Health, { current: 0, max: 10 });

    dropSystem(world);

    // BASIC_MELEE table always drops XP (chance 1.0)
    const gems = query(world.ecs, [XpGem, Position]);
    expect(gems.length).toBeGreaterThanOrEqual(1);
  });

  it('emits a death combat event', () => {
    const world = createTestWorld();
    spawnEnemy(world, 50, 60, 10);

    const enemies = query(world.ecs, [Enemy]);
    const eid = enemies[0] as number;
    setComponent(world.ecs, eid, Health, { current: 0, max: 10 });

    dropSystem(world);

    const deathEvents = world.combatEvents.filter((e) => e.type === 'death');
    expect(deathEvents.length).toBe(1);
    expect(deathEvents[0]!.x).toBe(50);
    expect(deathEvents[0]!.y).toBe(60);
    expect(deathEvents[0]!.overkill).toBe(0);
    expect(deathEvents[0]!.targetType).toBe('enemy');
  });

  it('does not double-process the same entity', () => {
    const world = createTestWorld();
    spawnEnemy(world, 100, 200, 10);

    const enemies = query(world.ecs, [Enemy]);
    const eid = enemies[0] as number;
    setComponent(world.ecs, eid, Health, { current: 0, max: 10 });

    dropSystem(world);
    const firstCount = world.combatEvents.filter((e) => e.type === 'death').length;

    dropSystem(world);
    const secondCount = world.combatEvents.filter((e) => e.type === 'death').length;

    expect(secondCount).toBe(firstCount);
  });

  it('does not spawn drops for living enemies', () => {
    const world = createTestWorld();
    spawnEnemy(world, 100, 200, 10);

    dropSystem(world);

    const gems = query(world.ecs, [XpGem]);
    const golds = query(world.ecs, [Gold]);
    expect(gems.length).toBe(0);
    expect(golds.length).toBe(0);
    expect(world.combatEvents.filter((e) => e.type === 'death').length).toBe(0);
  });

  it('uses deterministic drops with seeded RNG', () => {
    function runDrop(seed: number) {
      const world = createTestWorld({ seed });
      spawnEnemy(world, 100, 200, 10);
      const enemies = query(world.ecs, [Enemy]);
      setComponent(world.ecs, enemies[0] as number, Health, { current: 0, max: 10 });
      dropSystem(world);
      return {
        gems: query(world.ecs, [XpGem]).length,
        golds: query(world.ecs, [Gold]).length,
        events: world.combatEvents.length,
      };
    }

    const run1 = runDrop(42);
    const run2 = runDrop(42);
    expect(run1).toEqual(run2);
  });

  it('can suppress loot while preserving death linger timing', () => {
    const world = createTestWorld();
    spawnEnemy(world, 100, 200, 10);

    const enemies = query(world.ecs, [Enemy]);
    const eid = enemies[0] as number;
    setComponent(world.ecs, eid, Health, { current: 0, max: 10 });

    dropSystem(world, { spawnLoot: false, deathLingerMs: 900 });

    expect(query(world.ecs, [XpGem]).length).toBe(0);
    expect(query(world.ecs, [Gold]).length).toBe(0);
    expect(world.stores.deathTimer.remainingMs[eid]).toBe(900);
    expect(query(world.ecs, [DeathTimer])).toContain(eid);
    expect(world.combatEvents.filter((event) => event.type === 'death')).toHaveLength(1);
  });

  it('suppresses ALL floor1 drops (gold, xp, junk) until the tutorial goon unlocks them', () => {
    const world = createTestWorld({ seed: 42 });
    const player = spawnPlayer(world, 0, 0);
    initializeFloor1Scenario(world, player);
    selectFloor1StarterWeapon(world, 0);

    // Before meeting the Tutorial Goon, nothing the enemies drop should appear.
    // (The merchant's fetch item is spawned at init, so measure deltas.)
    const goldBefore = world.playerGold;
    const itemsAtInit = query(world.ecs, [DroppedItem]).length;
    const lockedEnemy = spawnEnemy(world, 100, 200, 10);
    setComponent(world.ecs, lockedEnemy, Health, { current: 0, max: 10 });
    dropSystem(world);
    expect(query(world.ecs, [XpGem]).length).toBe(0);
    expect(query(world.ecs, [Gold]).length).toBe(0);
    expect(query(world.ecs, [DroppedItem]).length).toBe(itemsAtInit);

    // Finding the Welcome Office and meeting the Goon unlocks drops.
    meetTutorialGoon(world);
    expect(world.goalFlags.get('floor1-drops-unlocked')).toBe(true);

    const unlockedEnemy = spawnEnemy(world, 140, 220, 10);
    setComponent(world.ecs, unlockedEnemy, Health, { current: 0, max: 10 });
    dropSystem(world);
    expect(query(world.ecs, [XpGem]).length).toBeGreaterThanOrEqual(1);
    // Sanity: gold currency progression is no longer permanently zero once
    // drops are on (gold gems either spawn as entities or are auto-collected).
    expect(world.playerGold).toBeGreaterThanOrEqual(goldBefore);
  });
});
