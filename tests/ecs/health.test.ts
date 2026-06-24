import { entityExists, hasComponent, query, setComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Health, Player, Position, XpGem } from '../../src/core/components.js';
import { spawnEnemy, spawnPlayer } from '../../src/core/helpers.js';
import { healthSystem } from '../../src/core/systems/healthSystem.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { deathTimerSystem } from '../../src/core/systems/deathTimerSystem.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('healthSystem', () => {
  it('keeps entities with health above zero', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 100, 200, 25);

    healthSystem(world);

    expect(entityExists(world.ecs, eid)).toBe(true);
    expect(world.state).toBe('playing');
  });

  it('removes entities with health at or below zero (after death timer expires)', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 100, 200, 25);

    setComponent(world.ecs, eid, Health, { current: 0, max: 25 });
    dropSystem(world);
    healthSystem(world);

    // Entity has DeathTimer now — healthSystem skips it
    expect(entityExists(world.ecs, eid)).toBe(true);

    // Run deathTimerSystem enough frames to expire the 3000ms timer (~180 frames at 16.67ms)
    for (let i = 0; i < 185; i++) {
      deathTimerSystem(world);
    }

    expect(entityExists(world.ecs, eid)).toBe(false);
  });

  it('sets game over for the player instead of removing it', () => {
    const world = createTestWorld();
    const eid = spawnPlayer(world, 100, 200);

    setComponent(world.ecs, eid, Health, { current: -1, max: 100 });
    healthSystem(world);

    expect(entityExists(world.ecs, eid)).toBe(true);
    expect(hasComponent(world.ecs, eid, Player)).toBe(true);
    expect(world.state).toBe('game_over');
  });

  it('drops loot at enemy death position via dropSystem', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 42, 77, 10);

    setComponent(world.ecs, eid, Health, { current: 0, max: 10 });
    dropSystem(world);
    healthSystem(world);

    // dropSystem spawns XP gems based on loot tables
    const gems = query(world.ecs, [XpGem, Position]);
    expect(gems.length).toBeGreaterThanOrEqual(1);
  });
});
