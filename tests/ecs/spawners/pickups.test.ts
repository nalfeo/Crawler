import { hasComponent } from 'bitecs';
import { describe, expect, it } from 'vitest';
import {
  Gold,
  Owner,
  Position,
  Sprite,
  Team,
  Weapon,
  XpGem,
} from '../../../src/core/components.js';
import {
  spawnDroppedItem,
  spawnGold,
  spawnWeapon,
  spawnXpGem,
} from '../../../src/core/spawners/pickups.js';
import { WeaponType } from '../../../src/shared/constants.js';
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

describe('spawnWeapon', () => {
  it('stores weapon stats with primed lastFireMs, Owner, and Team', () => {
    const world = createTestWorld();
    const ownerEid = 7;
    const eid = spawnWeapon(world, ownerEid, WeaponType.RANGED, 12, 500, 30, 18, 1);

    expect(hasComponent(world.ecs, eid, Weapon)).toBe(true);
    expect(hasComponent(world.ecs, eid, Owner)).toBe(true);
    expect(hasComponent(world.ecs, eid, Team)).toBe(true);
    expect(world.stores.weapon.weaponType[eid]).toBe(WeaponType.RANGED);
    expect(world.stores.weapon.baseDamage[eid]).toBe(12);
    expect(world.stores.weapon.cooldownMs[eid]).toBe(500);
    // Primed so the weapon can fire immediately on its first tick.
    expect(world.stores.weapon.lastFireMs[eid]).toBe(-500);
    expect(world.stores.weapon.range[eid]).toBe(30);
    expect(world.stores.weapon.projectileSpeed[eid]).toBe(18);
    expect(world.stores.owner.eid[eid]).toBe(ownerEid);
    expect(world.stores.team.id[eid]).toBe(1);
  });
});
