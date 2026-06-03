import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Enemy,
  Health,
  Player,
  Position,
  Sprite,
  Velocity,
  XpGem,
} from '../../src/core/components.js';
import { clearEntityStores, createEntity, spawnEnemy, spawnPlayer, spawnXpGem } from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('spawn helpers', () => {
  it('spawnPlayer creates an entity with all expected components including Sprite', () => {
    const world = createTestWorld();
    const eid = spawnPlayer(world, 12, 34);

    expect(hasComponent(world.ecs, eid, Position)).toBe(true);
    expect(hasComponent(world.ecs, eid, Velocity)).toBe(true);
    expect(hasComponent(world.ecs, eid, Health)).toBe(true);
    expect(hasComponent(world.ecs, eid, Player)).toBe(true);
    expect(hasComponent(world.ecs, eid, Sprite)).toBe(true);
    expect(world.stores.position.x[eid]).toBe(12);
    expect(world.stores.position.y[eid]).toBe(34);
    expect(world.stores.velocity.x[eid]).toBe(0);
    expect(world.stores.velocity.y[eid]).toBe(0);
    expect(world.stores.health.current[eid]).toBe(100);
    expect(world.stores.health.max[eid]).toBe(100);
    expect(world.stores.sprite.width[eid]).toBe(24);
    expect(world.stores.sprite.height[eid]).toBe(24);
  });

  it('spawnEnemy creates an enemy with Sprite for rendering', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, -20, 45, 60);

    expect(hasComponent(world.ecs, eid, Position)).toBe(true);
    expect(hasComponent(world.ecs, eid, Velocity)).toBe(true);
    expect(hasComponent(world.ecs, eid, Health)).toBe(true);
    expect(hasComponent(world.ecs, eid, Enemy)).toBe(true);
    expect(hasComponent(world.ecs, eid, Sprite)).toBe(true);
    expect(world.stores.position.x[eid]).toBe(-20);
    expect(world.stores.position.y[eid]).toBe(45);
    expect(world.stores.health.current[eid]).toBe(60);
    expect(world.stores.health.max[eid]).toBe(60);
    expect(world.stores.sprite.width[eid]).toBe(16);
    expect(world.stores.sprite.height[eid]).toBe(16);
  });

  it('spawnXpGem creates an xp gem with Sprite for rendering', () => {
    const world = createTestWorld();
    const eid = spawnXpGem(world, 5, -7, 9);

    expect(hasComponent(world.ecs, eid, Position)).toBe(true);
    expect(hasComponent(world.ecs, eid, XpGem)).toBe(true);
    expect(hasComponent(world.ecs, eid, Sprite)).toBe(true);
    expect(world.stores.position.x[eid]).toBe(5);
    expect(world.stores.position.y[eid]).toBe(-7);
    expect(world.stores.xpGem.value[eid]).toBe(9);
    expect(world.stores.sprite.width[eid]).toBe(8);
    expect(world.stores.sprite.height[eid]).toBe(8);
  });
});

describe('entity recycling safety', () => {
  it('clearEntityStores zeros all store slots for an entity', () => {
    const world = createTestWorld();
    const eid = spawnEnemy(world, 100, 200, 50);

    // Confirm data is set
    expect(world.stores.position.x[eid]).toBe(100);
    expect(world.stores.health.current[eid]).toBe(50);

    clearEntityStores(world, eid);

    // All slots zeroed
    expect(world.stores.position.x[eid]).toBe(0);
    expect(world.stores.position.y[eid]).toBe(0);
    expect(world.stores.health.current[eid]).toBe(0);
    expect(world.stores.health.max[eid]).toBe(0);
    expect(world.stores.sprite.width[eid]).toBe(0);
  });

  it('createEntity returns an entity with zeroed stores', () => {
    const world = createTestWorld();

    // Dirty a store slot manually at ID 0
    world.stores.position.x[0] = 999;
    world.stores.health.current[0] = 42;

    // Create entity (may get ID 0 if fresh world)
    const eid = createEntity(world);

    // Stores should be zeroed regardless of prior data
    expect(world.stores.position.x[eid]).toBe(0);
    expect(world.stores.health.current[eid]).toBe(0);
  });
});
