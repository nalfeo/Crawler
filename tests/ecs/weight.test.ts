import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Weight } from '../../src/core/components.js';
import {
  spawnBehaviorEnemy,
  spawnDroppedItem,
  spawnEnemy,
  spawnGold,
  spawnPlayer,
  spawnProjectile,
  spawnXpGem,
} from '../../src/core/helpers.js';
import { createTestWorld } from '../helpers/world-factory.js';

describe('Weight component', () => {
  describe('spawnPlayer', () => {
    it('adds Weight component with default 180 lbs', () => {
      const world = createTestWorld();
      const eid = spawnPlayer(world, 0, 0);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(180);
    });

    it('accepts a custom weight', () => {
      const world = createTestWorld();
      const eid = spawnPlayer(world, 0, 0, 250);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(250);
    });
  });

  describe('spawnEnemy', () => {
    it('adds Weight component with default 120 lbs', () => {
      const world = createTestWorld();
      const eid = spawnEnemy(world, 0, 0, 50);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(120);
    });

    it('accepts a custom weight', () => {
      const world = createTestWorld();
      const eid = spawnEnemy(world, 0, 0, 50, 300);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(300);
    });
  });

  describe('spawnBehaviorEnemy', () => {
    it('adds Weight component with default 120 lbs', () => {
      const world = createTestWorld();
      const eid = spawnBehaviorEnemy(world, 0, 0, 50, 0, 2, 100, 50);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(120);
    });

    it('accepts weight via options', () => {
      const world = createTestWorld();
      const eid = spawnBehaviorEnemy(world, 0, 0, 50, 0, 2, 100, 50, { weight: 400 });

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(400);
    });
  });

  describe('spawnXpGem', () => {
    it('adds Weight component with default 1 lb', () => {
      const world = createTestWorld();
      const eid = spawnXpGem(world, 0, 0, 10);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(1);
    });

    it('accepts a custom weight', () => {
      const world = createTestWorld();
      const eid = spawnXpGem(world, 0, 0, 10, 3);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(3);
    });
  });

  describe('spawnGold', () => {
    it('adds Weight component with default 1 lb', () => {
      const world = createTestWorld();
      const eid = spawnGold(world, 0, 0, 50);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(1);
    });

    it('accepts a custom weight', () => {
      const world = createTestWorld();
      const eid = spawnGold(world, 0, 0, 50, 2);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(2);
    });
  });

  describe('spawnDroppedItem', () => {
    it('adds Weight component with default 5 lbs', () => {
      const world = createTestWorld();
      const eid = spawnDroppedItem(world, 0, 0, 0);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(5);
    });

    it('accepts a custom weight', () => {
      const world = createTestWorld();
      const eid = spawnDroppedItem(world, 0, 0, 0, 20);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(20);
    });
  });

  describe('spawnProjectile', () => {
    it('adds Weight component with default 1 lb', () => {
      const world = createTestWorld();
      const eid = spawnProjectile(world, 0, 0, 1, 0, 10);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(1);
    });

    it('accepts a custom weight', () => {
      const world = createTestWorld();
      const eid = spawnProjectile(world, 0, 0, 1, 0, 10, 0, 0, 5);

      expect(hasComponent(world.ecs, eid, Weight)).toBe(true);
      expect(world.stores.weight.value[eid]).toBe(5);
    });
  });
});
