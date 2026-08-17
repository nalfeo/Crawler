import { describe, expect, it } from 'vitest';
import { listGeneratedEquipmentInstances } from '../../src/core/generated-equipment-registry.js';
import {
  createInitialFloor2QuartermasterStock,
  _restockFloor2Quartermaster,
} from '../../src/game/quartermaster-stock.js';
import tuning from '../../src/shared/data/tuning.json';
import type {
  Floor2QuartermasterStockState,
  Floor2SettlementSnapshot,
} from '../../src/shared/floor-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

function enableQuartermasterEconomy(world: ReturnType<typeof createTestWorld>): void {
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
}

function attachStock(
  world: ReturnType<typeof createTestWorld>,
  quartermasterStock: Floor2QuartermasterStockState,
): void {
  const settlement: Floor2SettlementSnapshot = {
    settlementRoomId: 1,
    settlementRoomIds: [1, 2],
    brokerEid: 1,
    defectorEid: 2,
    defectorFamilyId: 'goblins',
    defectorAppearanceKey: 'goblin-brute',
    defectorFallbackAppearanceKey: 'goblin',
    quartermasterShop: {
      archetypeId: 'quartermaster',
      npcId: 'quartermaster',
      npcEid: 3,
      inventory: [],
    },
    quartermasterStock,
    shops: [],
  };
  world.floorExtendedState = { settlement };
}

describe('Floor 2 Quartermaster generated stock', () => {
  it('generates byte-stable level-appropriate common/uncommon gear without consuming world RNG', () => {
    const left = createTestWorld({ seed: 42, floor: 2 });
    const right = createTestWorld({ seed: 42, floor: 2 });
    const rngControl = createTestWorld({ seed: 42, floor: 2 });
    enableQuartermasterEconomy(left);
    enableQuartermasterEconomy(right);
    left.playerLevel.level = 7;
    right.playerLevel.level = 7;

    const leftStock = createInitialFloor2QuartermasterStock(left);
    const rightStock = createInitialFloor2QuartermasterStock(right);
    expect(leftStock).toBeDefined();
    expect(rightStock).toBeDefined();
    if (!leftStock || !rightStock) return;

    expect(leftStock).toEqual(rightStock);
    expect(listGeneratedEquipmentInstances(left)).toEqual(listGeneratedEquipmentInstances(right));
    expect(leftStock.offers.length).toBeGreaterThanOrEqual(3);
    expect(leftStock.offers.length).toBeLessThanOrEqual(4);
    expect(leftStock.offers.map((offer) => offer.rarity)).toEqual(
      expect.arrayContaining(['common', 'uncommon']),
    );
    expect(left.rng.next()).toBe(rngControl.rng.next());

    for (const offer of leftStock.offers) {
      const instance = listGeneratedEquipmentInstances(left).find(
        (candidate) => candidate.instanceId === offer.instanceId,
      );
      expect(instance).toBeDefined();
      // Level is rolled from max(1, playerLevel-1)..playerLevel+1 (spec §552-554).
      expect(instance?.itemLevel).toBeGreaterThanOrEqual(Math.max(1, left.playerLevel.level - 1));
      expect(instance?.itemLevel).toBeLessThanOrEqual(left.playerLevel.level + 1);
      expect(instance?.rarity).toBe(offer.rarity);
      expect(instance?.rarity).not.toBe('rare');
      expect(instance?.enhancementLevel).toBe(0);
      expect(instance?.frozen.activeWeaponSnapshot).toBeNull();
      const expectedPrice = Math.max(
        1,
        Math.round(
          (20 + (instance?.itemLevel ?? 0) * 5) *
            (offer.rarity === 'uncommon' ? 1.5 : 1) *
            tuning.shopPricing.floor2TierMultiplier,
        ),
      );
      expect(offer.unitPrice).toBe(expectedPrice);
      expect(
        instance?.resolvedEffects.every((effect) => 'kind' in effect && effect.kind === 'stat'),
      ).toBe(true);
      expect(offer.quantity).toBe(1);
    }
  });

  it('advances exactly one epoch, is idempotent within an epoch, and retires only unsold stock', () => {
    const world = createTestWorld({ seed: 91, floor: 2 });
    enableQuartermasterEconomy(world);
    const initial = createInitialFloor2QuartermasterStock(world);
    expect(initial).toBeDefined();
    if (!initial) return;
    const soldId = initial.offers[0]!.instanceId;
    const partiallySold: Floor2QuartermasterStockState = {
      ...initial,
      offers: initial.offers.map((offer, index) =>
        index === 0 ? { ...offer, quantity: 0 } : offer,
      ),
    };
    attachStock(world, partiallySold);

    const repeated = _restockFloor2Quartermaster(world, 0);
    expect(repeated).toEqual({ ok: true, changed: false, stock: partiallySold });

    const skipped = _restockFloor2Quartermaster(world, 2);
    expect(skipped).toMatchObject({ ok: false, reason: 'invalid-epoch' });
    expect(world.floorExtendedState?.settlement?.quartermasterStock).toBe(partiallySold);

    const advanced = _restockFloor2Quartermaster(world, 1);
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.changed).toBe(true);
    expect(advanced.stock.restockEpoch).toBe(1);
    expect(advanced.stock.stockId).not.toBe(initial.stockId);
    expect(advanced.stock.retiredInstanceIds).not.toContain(soldId);
    for (const offer of initial.offers.slice(1)) {
      expect(advanced.stock.retiredInstanceIds).toContain(offer.instanceId);
    }
    expect(advanced.stock.offers.every((offer) => offer.quantity === 1)).toBe(true);
  });

  it('returns an explicit failure when restock is requested before settlement creation', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    enableQuartermasterEconomy(world);

    expect(_restockFloor2Quartermaster(world, 1)).toEqual({
      ok: false,
      reason: 'missing-settlement',
      message: 'Floor 2 settlement must exist before Quartermaster restock',
    });
  });

  it('does not auto-enable the equipment economy or configure the registry by default', () => {
    const world = createTestWorld({ seed: 42, floor: 2, generatedEquipmentRunKey: null });

    expect(createInitialFloor2QuartermasterStock(world)).toBeUndefined();
    expect(world.generatedEquipmentRegistry.runKey).toBeNull();
    expect(listGeneratedEquipmentInstances(world)).toEqual([]);
  });

  it('returns undefined and does not mutate the registry when economy flags are set on a non-Floor-2 world', () => {
    const world = createTestWorld({ seed: 42, floor: 1, generatedEquipmentRunKey: null });
    enableQuartermasterEconomy(world);

    expect(createInitialFloor2QuartermasterStock(world)).toBeUndefined();
    expect(world.generatedEquipmentRegistry.runKey).toBeNull();
    expect(listGeneratedEquipmentInstances(world)).toEqual([]);
  });

  it('rejects an enabled economy without its registry/catalog dependency closure', () => {
    const world = createTestWorld({ seed: 42, floor: 2, generatedEquipmentRunKey: null });
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;

    expect(() => createInitialFloor2QuartermasterStock(world)).toThrow(
      'floor2EquipmentEconomy requires floor2EquipmentRegistry and floor2EquipmentCatalog',
    );
    expect(world.generatedEquipmentRegistry.runKey).toBeNull();
  });

  it('returns an explicit failure when the economy is enabled after settlement creation', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    enableQuartermasterEconomy(world);
    world.floorExtendedState = {
      settlement: {
        settlementRoomId: 1,
        settlementRoomIds: [1, 2],
        brokerEid: 1,
        defectorEid: 2,
        defectorFamilyId: 'goblins',
        defectorAppearanceKey: 'goblin-brute',
        defectorFallbackAppearanceKey: 'goblin',
        quartermasterShop: {
          archetypeId: 'quartermaster',
          npcId: 'quartermaster',
          npcEid: 3,
          inventory: [],
        },
        shops: [],
      },
    };

    expect(_restockFloor2Quartermaster(world, 1)).toEqual({
      ok: false,
      reason: 'missing-stock',
      message: 'Quartermaster generated stock is not initialized',
    });
  });

  it('blocks restock mutation when the economy is later disabled or misconfigured', () => {
    const world = createTestWorld({ seed: 91, floor: 2 });
    enableQuartermasterEconomy(world);
    const initial = createInitialFloor2QuartermasterStock(world);
    expect(initial).toBeDefined();
    if (!initial) return;
    attachStock(world, initial);

    world.floor2EquipmentFlags.floor2EquipmentEconomy = false;
    expect(_restockFloor2Quartermaster(world, 1)).toEqual({
      ok: false,
      reason: 'economy-disabled',
      message: 'Floor 2 equipment economy is disabled',
    });
    expect(world.floorExtendedState?.settlement?.quartermasterStock).toBe(initial);

    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = false;
    expect(_restockFloor2Quartermaster(world, 1)).toEqual({
      ok: false,
      reason: 'invalid-equipment-config',
      message: 'floor2EquipmentEconomy requires floor2EquipmentRegistry and floor2EquipmentCatalog',
    });
    expect(world.floorExtendedState?.settlement?.quartermasterStock).toBe(initial);
  });

  it('generates stock using the explicit effectivePlayerLevel when world.playerLevel is not yet updated', () => {
    // Simulates a Floor 1→2 carryover where world.playerLevel is still the
    // default (1) at settlement-init time but the intended level is 8.
    const world = createTestWorld({ seed: 42, floor: 2 });
    enableQuartermasterEconomy(world);
    // world.playerLevel.level is intentionally left at its default (0) to
    // simulate a pre-carryover state.
    expect(world.playerLevel.level).toBe(0);

    const effectiveLevel = 8;
    const stock = createInitialFloor2QuartermasterStock(world, effectiveLevel);
    expect(stock).toBeDefined();
    if (!stock) return;

    for (const offer of stock.offers) {
      const instance = listGeneratedEquipmentInstances(world).find(
        (candidate) => candidate.instanceId === offer.instanceId,
      );
      expect(instance).toBeDefined();
      expect(instance?.itemLevel).toBeGreaterThanOrEqual(Math.max(1, effectiveLevel - 1));
      expect(instance?.itemLevel).toBeLessThanOrEqual(effectiveLevel + 1);
    }
  });

  it('generates different stock when effectivePlayerLevel differs from world.playerLevel', () => {
    const worldAtDefault = createTestWorld({ seed: 42, floor: 2 });
    const worldExplicit = createTestWorld({ seed: 42, floor: 2 });
    enableQuartermasterEconomy(worldAtDefault);
    enableQuartermasterEconomy(worldExplicit);

    // Both worlds have playerLevel.level = 1 (default).
    const stockDefault = createInitialFloor2QuartermasterStock(worldAtDefault);
    // Pass level 10 explicitly — simulating a high-level carryover.
    const stockExplicit = createInitialFloor2QuartermasterStock(worldExplicit, 10);

    expect(stockDefault).toBeDefined();
    expect(stockExplicit).toBeDefined();
    if (!stockDefault || !stockExplicit) return;

    // The stock IDs use seed + epoch only (not level), so they are equal;
    // but the generated item levels should differ between the two.
    expect(stockDefault.stockId).toBe(stockExplicit.stockId);
    const defaultLevels = listGeneratedEquipmentInstances(worldAtDefault).map((i) => i.itemLevel);
    const explicitLevels = listGeneratedEquipmentInstances(worldExplicit).map((i) => i.itemLevel);
    // High-level stock offers must be above the default band [1, 2].
    expect(explicitLevels.some((l) => l > 2)).toBe(true);
    expect(defaultLevels.every((l) => l <= 2)).toBe(true);
  });
});
