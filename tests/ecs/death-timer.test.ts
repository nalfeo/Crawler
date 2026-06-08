import { describe, it, expect } from 'vitest';
import { addComponent, hasComponent, query, set } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import { deathTimerSystem } from '../../src/core/systems/deathTimerSystem.js';
import { healthSystem } from '../../src/core/systems/healthSystem.js';
import { DeathTimer, Enemy, Health } from '../../src/core/components.js';
import { createEntity } from '../../src/core/helpers.js';

describe('deathTimerSystem', () => {
  it('removes entity when timer expires', () => {
    const world = createTestWorld({ seed: 1 });
    const eid = createEntity(world);

    // Setup: enemy at 0 HP with a short death timer
    addComponent(world.ecs, eid, set(Health, { current: 0, max: 10 }));
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 30 }));

    // First frame: timer decrements but entity still exists
    deathTimerSystem(world);
    const entitiesAfterFirst = query(world.ecs, [DeathTimer]);
    expect(Array.from(entitiesAfterFirst)).toContain(eid);

    // Enough frames to expire (~16.67ms per frame, 30ms timer → 2 frames)
    deathTimerSystem(world);
    const entitiesAfterSecond = query(world.ecs, [DeathTimer]);
    expect(Array.from(entitiesAfterSecond)).not.toContain(eid);
  });

  it('entity persists across multiple frames when timer is long', () => {
    const world = createTestWorld({ seed: 2 });
    const eid = createEntity(world);

    addComponent(world.ecs, eid, set(Health, { current: 0, max: 10 }));
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 300 }));

    // Run several frames — at ~16.67ms/frame, 300ms needs ~18 frames
    for (let i = 0; i < 10; i++) {
      deathTimerSystem(world);
    }

    // Should still exist after 10 frames (~167ms)
    const entities = query(world.ecs, [DeathTimer]);
    expect(Array.from(entities)).toContain(eid);

    // Run enough more frames to expire
    for (let i = 0; i < 10; i++) {
      deathTimerSystem(world);
    }

    // Should be gone now (~333ms elapsed)
    const entitiesAfter = query(world.ecs, [DeathTimer]);
    expect(Array.from(entitiesAfter)).not.toContain(eid);
  });

  it('healthSystem skips entities with DeathTimer', () => {
    const world = createTestWorld({ seed: 3 });
    const eid = createEntity(world);

    addComponent(world.ecs, eid, set(Health, { current: 0, max: 10 }));
    addComponent(world.ecs, eid, Enemy);
    addComponent(world.ecs, eid, set(DeathTimer, { remainingMs: 300 }));

    // healthSystem should skip this entity
    healthSystem(world);

    // Entity should still exist (not removed by healthSystem)
    expect(hasComponent(world.ecs, eid, DeathTimer)).toBe(true);
  });

  it('healthSystem removes 0-HP enemies without DeathTimer', () => {
    const world = createTestWorld({ seed: 4 });
    const eid = createEntity(world);

    addComponent(world.ecs, eid, set(Health, { current: 0, max: 10 }));
    addComponent(world.ecs, eid, Enemy);
    // No DeathTimer — healthSystem should remove it

    healthSystem(world);

    // Entity should be gone
    expect(hasComponent(world.ecs, eid, Health)).toBe(false);
  });
});
