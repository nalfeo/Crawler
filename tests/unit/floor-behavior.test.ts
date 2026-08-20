import { describe, expect, it } from 'vitest';
import { createTestWorld } from '../helpers/world-factory';
import { getWorldFloorBehavior, getWorldFloorManifest } from '../../src/core/floor-behavior';
import { DEFAULT_FLOOR_BEHAVIOR } from '../../src/shared/floor-behavior';
import { floor1Manifest, floor2Manifest } from '../../src/shared/floor-manifest';

describe('floor behavior config', () => {
  it('ships Floor 1 safe-room and boss-chest semantics in the manifest', () => {
    expect(floor1Manifest.behavior).toEqual({
      spawnRoomIsSafe: false,
      safeRoomWeaponImmunity: true,
      safeRoomDoorsAutoClose: true,
      lineOfSightAggro: false,
      equipmentEconomy: true,
      carriedMainHandWeapon: false,
      bossChests: true,
    });
  });

  it('ships Floor 2 settlement/economy semantics in the manifest', () => {
    expect(floor2Manifest.behavior).toEqual({
      spawnRoomIsSafe: true,
      safeRoomWeaponImmunity: false,
      safeRoomDoorsAutoClose: false,
      lineOfSightAggro: true,
      equipmentEconomy: true,
      carriedMainHandWeapon: false,
      bossChests: true,
    });
  });

  it('defaults every flag to off when a manifest omits the block', () => {
    expect(DEFAULT_FLOOR_BEHAVIOR).toEqual({
      spawnRoomIsSafe: false,
      safeRoomWeaponImmunity: false,
      safeRoomDoorsAutoClose: false,
      lineOfSightAggro: false,
      equipmentEconomy: false,
      carriedMainHandWeapon: false,
      bossChests: false,
    });
  });

  it('resolves behavior from the explicit floor id', () => {
    const world = createTestWorld();
    world.floorId = 'floor2';
    expect(getWorldFloorManifest(world)).toBe(floor2Manifest);
    expect(getWorldFloorBehavior(world).equipmentEconomy).toBe(true);
  });

  it('falls back to the numeric floor when no floor id is assigned yet', () => {
    const world = createTestWorld({ floor: 2 });
    expect(world.floorId).toBe('');
    expect(getWorldFloorBehavior(world).spawnRoomIsSafe).toBe(true);

    const floor1World = createTestWorld();
    expect(getWorldFloorBehavior(floor1World).safeRoomWeaponImmunity).toBe(true);
  });

  it('falls back to all-off defaults for an unregistered floor', () => {
    const world = createTestWorld({ floor: 99 });
    expect(getWorldFloorManifest(world)).toBeUndefined();
    expect(getWorldFloorBehavior(world)).toBe(DEFAULT_FLOOR_BEHAVIOR);
  });

  it('does not fall back by floor number when a non-empty floor id is unregistered', () => {
    const world = createTestWorld({ floor: 1 });
    world.floorId = 'floor3';
    expect(getWorldFloorManifest(world)).toBeUndefined();
    expect(getWorldFloorBehavior(world)).toBe(DEFAULT_FLOOR_BEHAVIOR);
  });
});
