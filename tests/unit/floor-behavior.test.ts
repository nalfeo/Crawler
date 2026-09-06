import { describe, expect, it } from 'vitest';
import { createTestWorld } from '../helpers/world-factory';
import { getWorldFloorBehavior, getWorldFloorManifest } from '../../src/core/floor-behavior';
import { DEFAULT_FLOOR_BEHAVIOR } from '../../src/shared/floor-behavior';
import { floor1Manifest, floor2Manifest, floor3Manifest } from '../../src/shared/floor-manifest';
import { getTerrainPack } from '../../src/shared/terrain-pack-registry';

describe('floor behavior config', () => {
  it('ships Floor 1 safe-room and boss-chest semantics in the manifest', () => {
    expect(floor1Manifest.behavior).toEqual({
      spawnRoomIsSafe: false,
      safeRoomPausesFloorTimer: true,
      safeRoomWeaponImmunity: true,
      safeRoomDoorsAutoClose: true,
      lineOfSightAggro: false,
      equipmentEconomy: true,
      carriedMainHandWeapon: false,
      bossChests: true,
      merchantCharmGatesEquipment: { prerequisiteQuestId: 'floor1-shopkeeper-errand' },
      merchantQuestGatesInventory: { prerequisiteQuestId: 'floor1-shopkeeper-errand' },
      settlementEquipmentEconomy: false,
      trashAttackWaves: true,
    });
  });

  it('ships Floor 2 settlement/economy semantics in the manifest', () => {
    expect(floor2Manifest.behavior).toEqual({
      spawnRoomIsSafe: true,
      safeRoomPausesFloorTimer: true,
      safeRoomWeaponImmunity: false,
      safeRoomDoorsAutoClose: false,
      lineOfSightAggro: true,
      equipmentEconomy: true,
      carriedMainHandWeapon: false,
      bossChests: true,
      merchantCharmGatesEquipment: null,
      merchantQuestGatesInventory: null,
      settlementEquipmentEconomy: true,
      trashAttackWaves: false,
    });
  });

  it('ships Floor 3 overworld wild-spawn semantics in the manifest', () => {
    expect(floor3Manifest.behavior).toEqual({
      spawnRoomIsSafe: true,
      safeRoomPausesFloorTimer: true,
      safeRoomWeaponImmunity: false,
      safeRoomDoorsAutoClose: false,
      lineOfSightAggro: true,
      equipmentEconomy: true,
      carriedMainHandWeapon: false,
      bossChests: false,
      merchantCharmGatesEquipment: null,
      merchantQuestGatesInventory: null,
      settlementEquipmentEconomy: false,
      trashAttackWaves: false,
    });
  });

  it('uses the bright outdoor Companion League terrain set on Floor 3', () => {
    expect(floor3Manifest.terrainPackId).toBe('companion-overworld');
    expect(floor3Manifest.props?.biomeTag).toBe('organic');
    expect(floor3Manifest.lighting.ambient).toBeGreaterThan(0.35);

    const pack = getTerrainPack('companion-overworld');
    expect(pack.name).toBe('Companion League Overworld');
    expect(pack.wallAutotile.textureKey).toContain('companion-overworld');
  });

  it('defaults every flag to off when a manifest omits the block', () => {
    expect(DEFAULT_FLOOR_BEHAVIOR).toEqual({
      spawnRoomIsSafe: false,
      safeRoomPausesFloorTimer: false,
      safeRoomWeaponImmunity: false,
      safeRoomDoorsAutoClose: false,
      lineOfSightAggro: false,
      equipmentEconomy: false,
      carriedMainHandWeapon: false,
      bossChests: false,
      merchantCharmGatesEquipment: null,
      merchantQuestGatesInventory: null,
      settlementEquipmentEconomy: false,
      trashAttackWaves: false,
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
    world.floorId = 'floor-does-not-exist';
    expect(getWorldFloorManifest(world)).toBeUndefined();
    expect(getWorldFloorBehavior(world)).toBe(DEFAULT_FLOOR_BEHAVIOR);
  });
});
