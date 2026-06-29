import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { BloodColor } from '../../../src/core/components.js';
import {
  DEFAULT_BLOOD_COLOR,
  clearEntityStores,
  createEntity,
  setBloodColor,
} from '../../../src/core/spawners/entity-core.js';
import { spawnEnemy } from '../../../src/core/spawners/combatants.js';
import { createTestWorld } from '../../helpers/world-factory.js';

describe('createEntity', () => {
  it('returns an entity with zeroed stores even after ID recycling', () => {
    const world = createTestWorld();

    // Dirty a store slot manually at ID 0
    world.stores.position.x[0] = 124.875;
    world.stores.health.current[0] = 42;

    const eid = createEntity(world);

    expect(world.stores.position.x[eid]).toBe(0);
    expect(world.stores.health.current[eid]).toBe(0);
  });
});

describe('clearEntityStores', () => {
  it('zeros all typed-array store slots for an entity', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 12.5, 25, 50);

    expect(world.stores.position.x[eid]).toBe(12.5);
    expect(world.stores.health.current[eid]).toBe(50);

    clearEntityStores(world, eid);

    expect(world.stores.position.x[eid]).toBe(0);
    expect(world.stores.position.y[eid]).toBe(0);
    expect(world.stores.health.current[eid]).toBe(0);
    expect(world.stores.health.max[eid]).toBe(0);
    expect(world.stores.sprite.width[eid]).toBe(0);
    expect(world.stores.enemyBehavior.type[eid]).toBe(0);
    expect(world.stores.enemyBehavior.speed[eid]).toBe(0);
  });
});

describe('setBloodColor', () => {
  it('adds BloodColor and unpacks the packed 0xRRGGBB integer into channels', () => {
    const world = createTestWorld();
    const eid = createEntity(world);

    setBloodColor(world, eid, 0x12345a);

    expect(hasComponent(world.ecs, eid, BloodColor)).toBe(true);
    expect(world.stores.bloodColor.r[eid]).toBe(0x12);
    expect(world.stores.bloodColor.g[eid]).toBe(0x34);
    expect(world.stores.bloodColor.b[eid]).toBe(0x5a);
  });
});

describe('DEFAULT_BLOOD_COLOR re-export', () => {
  it('is the shared default red', () => {
    expect(DEFAULT_BLOOD_COLOR).toBe(0xcc0000);
  });
});
