import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import { purchaseQuartermasterOffer } from '../../src/core/quartermaster-purchase.js';
import { createInitialFloor2QuartermasterStock } from '../../src/game/quartermaster-stock.js';
import type { Floor2SettlementSnapshot } from '../../src/shared/floor-types.js';
import { listGeneratedEquipmentReferences } from '../../src/shared/inventory.js';
import { createTestWorld } from '../helpers/world-factory.js';

function enableQuartermasterEconomy(world: ReturnType<typeof createTestWorld>): void {
  world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
  world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
  world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
}

describe('Quartermaster purchase properties', () => {
  it('conserves exact identity and currency on success and rolls back every unaffordable attempt', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), fc.boolean(), (seed, affordable) => {
        const world = createTestWorld({ seed, floor: 2 });
        enableQuartermasterEconomy(world);
        const playerEid = spawnPlayer(world, 0, 0);
        world.playerLevel.level = 1 + (seed % 20);
        const stock = createInitialFloor2QuartermasterStock(world);
        expect(stock).toBeDefined();
        if (!stock) return;
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
          quartermasterStock: stock,
          shops: [],
        };
        world.floorExtendedState = { settlement };
        const offer = stock.offers[0]!;
        world.playerGold = affordable ? offer.unitPrice + (seed % 100) : offer.unitPrice - 1;
        const goldBefore = world.playerGold;
        const request = { stockId: stock.stockId, offerId: offer.offerId, quantity: 1 };

        const result = purchaseQuartermasterOffer(world, playerEid, request);

        if (!affordable) {
          expect(result).toMatchObject({ ok: false, reason: 'insufficient-funds' });
          expect(world.playerGold).toBe(goldBefore);
          const bag = world.inventories.get(playerEid);
          expect(bag ? listGeneratedEquipmentReferences(bag) : undefined).toEqual([]);
          expect(world.floorExtendedState.settlement?.quartermasterStock?.offers[0]?.quantity).toBe(
            1,
          );
          return;
        }

        expect(result).toMatchObject({ ok: true, instanceId: offer.instanceId });
        expect(world.playerGold + offer.unitPrice).toBe(goldBefore);
        const bagAfterPurchase = world.inventories.get(playerEid);
        expect(
          bagAfterPurchase ? listGeneratedEquipmentReferences(bagAfterPurchase) : undefined,
        ).toEqual([{ kind: 'generated-instance', instanceKey: offer.instanceId }]);
        expect(world.floorExtendedState.settlement?.quartermasterStock?.offers[0]?.quantity).toBe(
          0,
        );
      }),
      { numRuns: 50, seed: 42 },
    );
  });
});
