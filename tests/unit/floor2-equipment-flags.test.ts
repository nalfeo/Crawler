import { describe, expect, it } from 'vitest';
import {
  getEquipmentEconomyAccess,
  getFloor2EquipmentEconomyAccess,
  getFloor2EquipmentRewardsAccess,
} from '../../src/core/floor2-equipment-flags.js';
import { createTestWorld } from '../helpers/world-factory.js';

/**
 * `getEquipmentEconomyAccess` is driven entirely by generic flags — the
 * floor's `equipmentEconomy` behavior flag (shared/floor-behavior.ts) plus
 * the per-world `floor2EquipmentFlags` a floor's scenario setup turns on —
 * with no hardcoded floor-id check. Floor 1's manifest declares
 * `equipmentEconomy: true` (for boss-chest rewards), so it's exercised below
 * to prove access is decided by flags, not by floor id.
 *
 * The Quartermaster/settlement economy and reward-bundle gates additionally
 * require the manifest-driven `settlementEquipmentEconomy` behavior flag,
 * which only Floor 2 opts into today — a data-driven floor gate rather than
 * a hardcoded floor id in the code.
 */
describe('floor2-equipment-flags access gates', () => {
  it('disables the economy when the per-world flag is off', () => {
    const world = createTestWorld();
    world.floorId = 'floor1';
    world.floor2EquipmentFlags.floor2EquipmentEconomy = false;
    expect(getEquipmentEconomyAccess(world).kind).toBe('disabled');
  });

  it('enables the generic economy on Floor 1 once every flag in the dependency closure is set', () => {
    const world = createTestWorld();
    world.floorId = 'floor1';
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    expect(getEquipmentEconomyAccess(world).kind).toBe('enabled');
  });

  it('disables the economy when the floor behavior itself has equipmentEconomy off', () => {
    const world = createTestWorld();
    // No manifest is registered for this floor id, so behavior resolves to
    // the all-off default regardless of the per-world flags below.
    world.floorId = 'no-such-floor';
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    expect(getEquipmentEconomyAccess(world).kind).toBe('disabled');
  });

  it('fails closed on a floor that does not opt into settlementEquipmentEconomy', () => {
    const world = createTestWorld();
    world.floorId = 'floor1';
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    world.floor2EquipmentFlags.floor2EquipmentRewards = true;
    expect(getFloor2EquipmentEconomyAccess(world).kind).toBe('disabled');
    expect(getFloor2EquipmentRewardsAccess(world).kind).toBe('disabled');
  });

  it('enables the Quartermaster economy on a floor that opts into settlementEquipmentEconomy', () => {
    const world = createTestWorld();
    world.floorId = 'floor2';
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    expect(getFloor2EquipmentEconomyAccess(world).kind).toBe('enabled');
  });

  it('reports an invalid economy when the registry/catalog dependencies are missing', () => {
    const world = createTestWorld();
    world.floorId = 'floor2';
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
    world.floor2EquipmentFlags.floor2EquipmentRegistry = false;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = false;
    expect(getFloor2EquipmentEconomyAccess(world).kind).toBe('invalid');
  });

  it('gates equipment rewards on the floor2EquipmentRewards flag once settlementEquipmentEconomy is on', () => {
    const world = createTestWorld();
    world.floorId = 'floor2';
    world.floor2EquipmentFlags.floor2EquipmentRewards = false;
    expect(getFloor2EquipmentRewardsAccess(world).kind).toBe('disabled');

    world.floor2EquipmentFlags.floor2EquipmentRewards = true;
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    expect(getFloor2EquipmentRewardsAccess(world).kind).toBe('enabled');
  });
});
