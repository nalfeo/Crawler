import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { Gold, Position, Sprite, XpGem } from '../../../src/core/components.js';
import { spawnDroppedItem, spawnGold, spawnXpGem } from '../../../src/core/spawners/pickups.js';
import { createTestWorld } from '../../helpers/world-factory.js';

describe('spawnXpGem', () => {
  it('creates an xp gem with value, sprite, and weight', () => {
    const world = createTestWorld();
    const eid = spawnXpGem(world, 0.625, -0.875, 9);

    expect(hasComponent(world.ecs, eid, Position)).toBe(true);
    expect(hasComponent(world.ecs, eid, XpGem)).toBe(true);
    expect(hasComponent(world.ecs, eid, Sprite)).toBe(true);
    expect(world.stores.xpGem.value[eid]).toBe(9);
    expect(world.stores.sprite.width[eid]).toBe(1);
    expect(world.stores.weight.value[eid]).toBe(1);
  });
});

describe('spawnGold', () => {
  it('creates a gold pickup with value, sprite, and weight', () => {
    const world = createTestWorld();
    const eid = spawnGold(world, 2, 3, 25, 4);

    expect(hasComponent(world.ecs, eid, Gold)).toBe(true);
    expect(hasComponent(world.ecs, eid, Sprite)).toBe(true);
    expect(world.stores.position.x[eid]).toBe(2);
    expect(world.stores.gold.value[eid]).toBe(25);
    expect(world.stores.sprite.width[eid]).toBe(1);
    expect(world.stores.weight.value[eid]).toBe(4);
  });
});

describe('spawnDroppedItem', () => {
  it('sanitizes the item index (floor + clamp into uint16)', () => {
    const world = createTestWorld();

    const floored = spawnDroppedItem(world, 0, 0, 3.9);
    expect(world.stores.droppedItem.itemIndex[floored]).toBe(3);
    expect(world.stores.sprite.width[floored]).toBe(1.25);
    expect(world.stores.weight.value[floored]).toBe(5);

    const negative = spawnDroppedItem(world, 0, 0, -5);
    expect(world.stores.droppedItem.itemIndex[negative]).toBe(0);

    const huge = spawnDroppedItem(world, 0, 0, 70000);
    expect(world.stores.droppedItem.itemIndex[huge]).toBe(0xffff);
  });
});
