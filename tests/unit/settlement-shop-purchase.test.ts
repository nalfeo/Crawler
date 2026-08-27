import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  getSettlementShopOfferViews,
  purchaseSettlementShopOffer,
} from '../../src/core/settlement-shop-purchase.js';
import type { Floor2SettlementSnapshot } from '../../src/shared/floor-types.js';
import { knownShopItemIds, loadShopArchetypes } from '../../src/shared/data/shop-archetypes.js';
import { getEquipmentDefForItem } from '../../src/shared/equipmentDefs.js';
import { listStaticInventorySlots } from '../../src/shared/inventory.js';
import { createTestWorld } from '../helpers/world-factory.js';

type TestWorld = ReturnType<typeof createTestWorld>;

function attachSettlement(world: TestWorld): number {
  const shopNpcEid = 7;
  const settlement: Floor2SettlementSnapshot = {
    settlementRoomId: 1,
    settlementRoomIds: [1, 2],
    brokerEid: 1,
    defectorEid: 2,
    defectorFamilyId: 'goblins',
    defectorAppearanceKey: 'goblin-brute',
    defectorFallbackAppearanceKey: 'goblin',
    quartermasterShop: {
      archetypeId: 'the-quartermaster',
      npcId: 'shop-the-quartermaster',
      npcEid: 3,
      inventory: [],
    },
    shops: [
      {
        archetypeId: 'the-ironmonger',
        npcId: 'shop-the-ironmonger',
        npcEid: shopNpcEid,
        inventory: [
          { itemId: 'throwing-knife', unitPrice: 125, stock: 1 },
          { itemId: 'baseball-bat', unitPrice: 150, stock: 1 },
        ],
      },
    ],
  };
  world.floorExtendedState = { settlement };
  return shopNpcEid;
}

describe('Settlement shop purchase', () => {
  it('projects the selected shop inventory as the shared UI read model', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    const playerEid = spawnPlayer(world, 0, 0);
    const shopNpcEid = attachSettlement(world);
    world.playerGold = 149;

    expect(getSettlementShopOfferViews(world, playerEid, shopNpcEid)).toEqual([
      {
        offerId: 'throwing-knife',
        itemId: 'throwing-knife',
        displayName: 'Throwing Knife',
        unitPrice: 125,
        quantity: 1,
        affordable: true,
        canPurchase: true,
        purchaseFailure: null,
        utility: null,
      },
      {
        offerId: 'baseball-bat',
        itemId: 'baseball-bat',
        displayName: 'Baseball Bat',
        unitPrice: 150,
        quantity: 1,
        affordable: false,
        canPurchase: false,
        purchaseFailure: 'insufficient-funds',
        utility: null,
      },
    ]);
  });

  it('commits gold, bag, and selected shop stock together on purchase', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    const playerEid = spawnPlayer(world, 0, 0);
    const shopNpcEid = attachSettlement(world);
    world.playerGold = 500;

    expect(
      purchaseSettlementShopOffer(world, playerEid, shopNpcEid, {
        itemId: 'throwing-knife',
        quantity: 1,
      }),
    ).toEqual({
      ok: true,
      goldSpent: 125,
      remainingGold: 375,
    });
    expect(world.playerGold).toBe(375);
    const bag = world.inventories.get(playerEid);
    expect(bag).toBeDefined();
    expect(listStaticInventorySlots(bag!)).toContainEqual({
      itemId: 'throwing-knife',
      quantity: 1,
    });
    expect(world.floorExtendedState?.settlement?.shops[0]?.inventory[0]?.stock).toBe(0);
    expect(
      purchaseSettlementShopOffer(world, playerEid, shopNpcEid, {
        itemId: 'throwing-knife',
        quantity: 1,
      }),
    ).toMatchObject({
      ok: false,
      reason: 'stock-unavailable',
    });
  });

  it('rejects unknown shops without mutating player state', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    const playerEid = spawnPlayer(world, 0, 0);
    attachSettlement(world);
    world.playerGold = 500;
    const beforeBag = structuredClone(world.inventories.get(playerEid));

    expect(
      purchaseSettlementShopOffer(world, playerEid, 999, {
        itemId: 'throwing-knife',
        quantity: 1,
      }),
    ).toEqual({
      ok: false,
      reason: 'unknown-shop',
      message: 'Settlement shop is missing or unknown',
    });
    expect(world.playerGold).toBe(500);
    expect(world.inventories.get(playerEid)).toEqual(beforeBag);
  });
  /**
   * Regression for #3693 ("why is bowling ball not purchasable"): shop stock is
   * rolled from the archetype entries, so every stocked id must resolve through
   * the purchase path. `bowling-ball` previously existed only in `weapons.json`,
   * so the offer rendered with its weapon name but refused the sale as
   * `unknown-item`.
   */
  it('can purchase every id the Floor 2 shop archetypes stock', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    const playerEid = spawnPlayer(world, 0, 0);
    const shopNpcEid = 11;
    const stockedIds = [
      ...new Set(
        loadShopArchetypes().flatMap((archetype) => archetype.entries.map((e) => e.itemId)),
      ),
    ];
    world.floorExtendedState = {
      settlement: {
        settlementRoomId: 1,
        settlementRoomIds: [1],
        brokerEid: 1,
        defectorEid: 2,
        defectorFamilyId: 'goblins',
        defectorAppearanceKey: 'goblin-brute',
        defectorFallbackAppearanceKey: 'goblin',
        quartermasterShop: {
          archetypeId: 'the-quartermaster',
          npcId: 'shop-the-quartermaster',
          npcEid: 3,
          inventory: [],
        },
        shops: [
          {
            archetypeId: 'the-resource-broker',
            npcId: 'shop-the-resource-broker',
            npcEid: shopNpcEid,
            inventory: stockedIds.map((itemId) => ({ itemId, unitPrice: 10, stock: 1 })),
          },
        ],
      } satisfies Floor2SettlementSnapshot,
    };
    world.playerGold = 10 * stockedIds.length;

    expect(stockedIds).toContain('bowling-ball');
    for (const offer of getSettlementShopOfferViews(world, playerEid, shopNpcEid)) {
      expect({ id: offer.itemId, canPurchase: offer.canPurchase }).toEqual({
        id: offer.itemId,
        canPurchase: true,
      });
      expect(offer.displayName).not.toBeNull();
    }

    expect(
      purchaseSettlementShopOffer(world, playerEid, shopNpcEid, {
        itemId: 'bowling-ball',
        quantity: 1,
      }),
    ).toMatchObject({ ok: true, goldSpent: 10 });
    const bag = world.inventories.get(playerEid);
    expect(bag).toBeDefined();
    expect(listStaticInventorySlots(bag!)).toContainEqual({ itemId: 'bowling-ball', quantity: 1 });
    // The purchased slug must activate the weapon when equipped, otherwise the
    // sale would only hand the player an inert bag entry.
    expect(getEquipmentDefForItem('bowling-ball')?.weaponId).toBe('bowling-ball');
  });

  it('only advertises stockable ids the purchase path can resolve', () => {
    const world = createTestWorld({ seed: 42, floor: 2 });
    const playerEid = spawnPlayer(world, 0, 0);
    const shopNpcEid = 7;
    world.floorExtendedState = {
      settlement: {
        settlementRoomId: 1,
        settlementRoomIds: [1],
        brokerEid: 1,
        defectorEid: 2,
        defectorFamilyId: 'goblins',
        defectorAppearanceKey: 'goblin-brute',
        defectorFallbackAppearanceKey: 'goblin',
        quartermasterShop: {
          archetypeId: 'the-quartermaster',
          npcId: 'shop-the-quartermaster',
          npcEid: 3,
          inventory: [],
        },
        shops: [
          {
            archetypeId: 'the-resource-broker',
            npcId: 'shop-the-resource-broker',
            npcEid: shopNpcEid,
            inventory: [...knownShopItemIds()].map((itemId) => ({
              itemId,
              unitPrice: 1,
              stock: 1,
            })),
          },
        ],
      } satisfies Floor2SettlementSnapshot,
    };
    world.playerGold = 1000;

    const blocked = getSettlementShopOfferViews(world, playerEid, shopNpcEid).filter(
      (offer) => !offer.canPurchase,
    );
    expect(blocked).toEqual([]);
  });
});
