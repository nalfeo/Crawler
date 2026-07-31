import { describe, expect, it } from 'vitest';
import {
  generatedEquipmentInstanceKey,
  getGeneratedEquipmentInstance,
  listGeneratedEquipmentInstances,
} from '../../src/core/generated-equipment-registry.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  getQuartermasterOfferViews,
  purchaseQuartermasterOffer,
  type QuartermasterPurchaseFailureCode,
  type QuartermasterPurchaseRequest,
} from '../../src/core/quartermaster-purchase.js';
import { createInitialFloor2QuartermasterStock } from '../../src/game/quartermaster-stock.js';
import type {
  Floor2QuartermasterStockState,
  Floor2SettlementSnapshot,
} from '../../src/shared/floor-types.js';
import { makeRunKey } from '../../src/shared/generated-equipment-types.js';
import { listGeneratedEquipmentReferences } from '../../src/shared/inventory.js';
import { createTestWorld } from '../helpers/world-factory.js';

type TestWorld = ReturnType<typeof createTestWorld>;

interface PurchaseContext {
  readonly world: TestWorld;
  readonly playerEid: number;
  readonly request: QuartermasterPurchaseRequest;
}

function enableQuartermasterEconomy(world: TestWorld): void {
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
}

function attachStock(world: TestWorld, quartermasterStock: Floor2QuartermasterStockState): void {
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

function setupPurchase(seed = 42): PurchaseContext {
  const world = createTestWorld({ seed, floor: 2 });
  enableQuartermasterEconomy(world);
  const playerEid = spawnPlayer(world, 0, 0);
  world.playerLevel.level = 5;
  const stock = createInitialFloor2QuartermasterStock(world);
  if (!stock) {
    throw new Error('Quartermaster test requires generated stock');
  }
  attachStock(world, stock);
  world.playerGold = 10_000;
  return {
    world,
    playerEid,
    request: {
      stockId: stock.stockId,
      offerId: stock.offers[0]!.offerId,
      quantity: 1,
    },
  };
}

function replaceStock(world: TestWorld, stock: Floor2QuartermasterStockState): void {
  const settlement = world.floorExtendedState?.settlement;
  if (!settlement) throw new Error('Test requires a settlement');
  world.floorExtendedState = {
    ...world.floorExtendedState,
    settlement: { ...settlement, quartermasterStock: stock },
  };
}

function transactionSnapshot(world: TestWorld): object {
  return structuredClone({
    playerGold: world.playerGold,
    inventories: [...world.inventories.entries()],
    stock: world.floorExtendedState?.settlement?.quartermasterStock,
    registry: listGeneratedEquipmentInstances(world),
  });
}

describe('Quartermaster atomic purchase', () => {
  it('projects one shared UI/AI affordability, capacity, and utility read model', () => {
    const { world, playerEid } = setupPurchase();
    const stock = world.floorExtendedState!.settlement!.quartermasterStock!;
    const offer = stock.offers[0]!;
    world.playerGold = offer.unitPrice - 1;

    const views = getQuartermasterOfferViews(world, playerEid);

    // Resolve the actual instance level (rolled from max(1,level-1)..level+1 at generation).
    const instance = listGeneratedEquipmentInstances(world).find(
      (i) => i.instanceId === offer.instanceId,
    );
    expect(instance).toBeDefined();
    const expectedItemLevel = instance!.itemLevel;
    expect(expectedItemLevel).toBeGreaterThanOrEqual(Math.max(1, world.playerLevel.level - 1));
    expect(expectedItemLevel).toBeLessThanOrEqual(world.playerLevel.level + 1);

    expect(views).toHaveLength(stock.offers.length);
    expect(views[0]).toMatchObject({
      stockId: stock.stockId,
      offerId: offer.offerId,
      instanceId: offer.instanceId,
      unitPrice: offer.unitPrice,
      quantity: 1,
      affordable: false,
      capacityAvailable: true,
      canPurchase: false,
      purchaseFailure: 'insufficient-funds',
      utility: {
        itemLevel: expectedItemLevel,
        rarity: offer.rarity,
        enhancementLevel: 0,
      },
    });
    expect(views[0]?.displayName).not.toBeNull();
    expect(views[0]?.utility?.slots.length).toBeGreaterThan(0);
  });

  it('transfers the exact registry instance once and commits gold, bag, and stock together', () => {
    const { world, playerEid, request } = setupPurchase();
    const stockBefore = world.floorExtendedState!.settlement!.quartermasterStock!;
    const offerBefore = stockBefore.offers[0]!;
    const instanceBefore = getGeneratedEquipmentInstance(world, offerBefore.instanceId);
    const goldBefore = world.playerGold;

    const purchased = purchaseQuartermasterOffer(world, playerEid, request);

    expect(purchased).toEqual({
      ok: true,
      instanceId: offerBefore.instanceId,
      goldSpent: offerBefore.unitPrice,
      remainingGold: goldBefore - offerBefore.unitPrice,
    });
    expect(getGeneratedEquipmentInstance(world, offerBefore.instanceId)).toBe(instanceBefore);
    const bagAfterPurchase = world.inventories.get(playerEid);
    expect(
      bagAfterPurchase ? listGeneratedEquipmentReferences(bagAfterPurchase) : undefined,
    ).toEqual([{ kind: 'generated-instance', instanceKey: offerBefore.instanceId }]);
    expect(world.floorExtendedState!.settlement!.quartermasterStock!.offers[0]!.quantity).toBe(0);

    const afterSuccess = transactionSnapshot(world);
    expect(purchaseQuartermasterOffer(world, playerEid, request)).toMatchObject({
      ok: false,
      reason: 'stock-unavailable',
    });
    expect(transactionSnapshot(world)).toEqual(afterSuccess);
  });

  it('disables offer projections and purchase mutations while preserving persisted stock', () => {
    const { world, playerEid, request } = setupPurchase();
    world.floor2EquipmentFlags.floor2EquipmentEconomy = false;
    const before = transactionSnapshot(world);

    expect(getQuartermasterOfferViews(world, playerEid)[0]).toMatchObject({
      stockId: request.stockId,
      offerId: request.offerId,
      canPurchase: false,
      purchaseFailure: 'economy-disabled',
      quantity: 1,
    });
    expect(purchaseQuartermasterOffer(world, playerEid, request)).toEqual({
      ok: false,
      reason: 'economy-disabled',
      message: 'Floor 2 equipment economy is disabled',
    });
    expect(transactionSnapshot(world)).toEqual(before);
  });

  it('disables offer projections and purchase mutations on a non-Floor-2 world while preserving persisted stock', () => {
    const { world, playerEid, request } = setupPurchase();
    world.floor = 1;
    const before = transactionSnapshot(world);

    expect(getQuartermasterOfferViews(world, playerEid)[0]).toMatchObject({
      stockId: request.stockId,
      offerId: request.offerId,
      canPurchase: false,
      purchaseFailure: 'economy-disabled',
      quantity: 1,
    });
    expect(purchaseQuartermasterOffer(world, playerEid, request)).toEqual({
      ok: false,
      reason: 'economy-disabled',
      message: 'Floor 2 equipment economy is only available on Floor 2',
    });
    expect(transactionSnapshot(world)).toEqual(before);
  });

  const failureCases: readonly {
    readonly name: string;
    readonly reason: QuartermasterPurchaseFailureCode;
    readonly arrange: (context: PurchaseContext) => QuartermasterPurchaseRequest;
  }[] = [
    {
      name: 'non-Floor-2 world (floor guard)',
      reason: 'economy-disabled',
      arrange: ({ world, request }) => {
        world.floor = 1;
        return request;
      },
    },
    {
      name: 'disabled economy consumer',
      reason: 'economy-disabled',
      arrange: ({ world, request }) => {
        world.floor2EquipmentFlags.floor2EquipmentEconomy = false;
        return request;
      },
    },
    {
      name: 'duplicate offer identity in persisted stock',
      reason: 'invalid-stock-identity',
      arrange: ({ world, request }) => {
        const stock = world.floorExtendedState!.settlement!.quartermasterStock!;
        replaceStock(world, {
          ...stock,
          offers: [...stock.offers, { ...stock.offers[0]!, offerId: request.offerId }],
        });
        return request;
      },
    },
    {
      name: 'invalid economy dependency closure',
      reason: 'invalid-equipment-config',
      arrange: ({ world, request }) => {
        world.floor2EquipmentFlags.floor2EquipmentCatalog = false;
        return request;
      },
    },
    {
      name: 'stale stock identity',
      reason: 'invalid-stock-identity',
      arrange: ({ request }) => ({ ...request, stockId: `${request.stockId}:stale` }),
    },
    {
      name: 'non-unit quantity',
      reason: 'invalid-quantity',
      arrange: ({ request }) => ({ ...request, quantity: 2 }),
    },
    {
      name: 'unknown offer identity',
      reason: 'unknown-offer',
      arrange: ({ request }) => ({ ...request, offerId: `${request.offerId}:missing` }),
    },
    {
      name: 'sold-out stock',
      reason: 'stock-unavailable',
      arrange: ({ world, request }) => {
        const stock = world.floorExtendedState!.settlement!.quartermasterStock!;
        replaceStock(world, {
          ...stock,
          offers: stock.offers.map((offer) =>
            offer.offerId === request.offerId ? { ...offer, quantity: 0 } : offer,
          ),
        });
        return request;
      },
    },
    {
      name: 'missing inventory',
      reason: 'missing-inventory',
      arrange: ({ world, playerEid, request }) => {
        world.inventories.delete(playerEid);
        return request;
      },
    },
    {
      name: 'insufficient funds',
      reason: 'insufficient-funds',
      arrange: ({ world, request }) => {
        world.playerGold = 0;
        return request;
      },
    },
    {
      name: 'full generated-equipment capacity',
      reason: 'inventory-capacity',
      arrange: ({ world, playerEid, request }) => {
        const bag = world.inventories.get(playerEid)!;
        world.inventories.set(playerEid, { ...bag, generatedEquipmentCapacity: 0 });
        return request;
      },
    },
    {
      name: 'missing registry instance',
      reason: 'instance-not-found',
      arrange: ({ world, request }) => {
        const stock = world.floorExtendedState!.settlement!.quartermasterStock!;
        const missingId = generatedEquipmentInstanceKey(makeRunKey('missing-instance'), 999);
        replaceStock(world, {
          ...stock,
          offers: stock.offers.map((offer) =>
            offer.offerId === request.offerId ? { ...offer, instanceId: missingId } : offer,
          ),
        });
        return request;
      },
    },
    {
      name: 'duplicate physical ownership',
      reason: 'ownership-conflict',
      arrange: ({ world, playerEid, request }) => {
        const stock = world.floorExtendedState!.settlement!.quartermasterStock!;
        const instanceKey = stock.offers[0]!.instanceId;
        const bag = world.inventories.get(playerEid)!;
        world.inventories.set(playerEid, {
          ...bag,
          generatedEquipment: [{ kind: 'generated-instance', instanceKey }],
        });
        return request;
      },
    },
    {
      name: 'retired active instance',
      reason: 'ownership-conflict',
      arrange: ({ world, request }) => {
        const stock = world.floorExtendedState!.settlement!.quartermasterStock!;
        replaceStock(world, {
          ...stock,
          retiredInstanceIds: [...stock.retiredInstanceIds, stock.offers[0]!.instanceId],
        });
        return request;
      },
    },
  ];

  for (const failureCase of failureCases) {
    it(`rejects ${failureCase.name} without partial writes`, () => {
      const context = setupPurchase();
      const request = failureCase.arrange(context);
      const before = transactionSnapshot(context.world);

      expect(purchaseQuartermasterOffer(context.world, context.playerEid, request)).toMatchObject({
        ok: false,
        reason: failureCase.reason,
      });
      expect(transactionSnapshot(context.world)).toEqual(before);
    });
  }
});
