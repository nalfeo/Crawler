import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { spawnPlayer } from '../../src/core/helpers.js';
import { getGenerator } from '../../src/core/map/generators/registry.js';
import {
  FLOOR2_SETTLEMENT_DOOR_BUFFER_TILES,
  initializeFloor2Settlement,
} from '../../src/game/floor2Settlement.js';
import { asFamilyId } from '../../src/core/faction-relations.js';
import { FLOOR2_QUARTERMASTER_ARCHETYPE_ID } from '../../src/shared/data/shop-archetypes.js';
import { BiomeType, type MapConfig } from '../../src/shared/map-types.js';
import { SeededRandom } from '../../src/shared/random.js';
import { createTestWorld } from '../helpers/world-factory.js';

function createSettlementWorld(seed: number) {
  const config: MapConfig = {
    widthTiles: 120,
    heightTiles: 90,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [7, 12],
    roomHeightRange: [6, 10],
    maxRooms: 35,
    floorDensity: 0.45,
  };
  const world = createTestWorld({ seed, floor: 2 });
  world.floorMap = getGenerator(BiomeType.CAVE_SYSTEM).generate(config, new SeededRandom(seed));
  spawnPlayer(world, 0, 0);
  world.floorExtendedState = {
    familyState: {
      presentFamilies: [asFamilyId('goblins'), asFamilyId('crabfolk'), asFamilyId('imps')],
      contestedResource: 'gold-veins' as never,
      betrayerFlag: false,
    },
  };
  return world;
}

function tryCreateSettlementWorld(seed: number): ReturnType<typeof createSettlementWorld> | null {
  try {
    return createSettlementWorld(seed);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CaveSystemGenerator: exhausted')) {
      return null;
    }
    throw error;
  }
}

describe('Floor 2 settlement placement properties', () => {
  it('fits exact-one Quartermaster plus the seeded random count deterministically across layouts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.constantFrom<1 | 2>(1, 2),
        (seed, shopCount) => {
          const firstWorld = tryCreateSettlementWorld(seed);
          if (!firstWorld) {
            fc.pre(false);
            return;
          }
          const secondWorld = createSettlementWorld(seed);
          const first = initializeFloor2Settlement(firstWorld, { shopCount });
          const second = initializeFloor2Settlement(secondWorld, { shopCount });

          expect(first.shops).toEqual(second.shops);
          expect(first.quartermasterShop).toEqual(second.quartermasterShop);
          expect(first.shops).toHaveLength(shopCount);
          expect(first.quartermasterShop.archetypeId).toBe(FLOOR2_QUARTERMASTER_ARCHETYPE_ID);
          expect(
            first.shops.every((shop) => shop.archetypeId !== FLOOR2_QUARTERMASTER_ARCHETYPE_ID),
          ).toBe(true);

          // Verify deterministic placement at the coordinate level, not just
          // inventory/EID equality. Identical seeds must place each NPC at the
          // same tile-world position across two independent worlds.
          const npcPairs: Array<[number, number]> = [
            [first.brokerEid, second.brokerEid],
            [first.defectorEid, second.defectorEid],
            [first.quartermasterShop.npcEid, second.quartermasterShop.npcEid],
            ...first.shops.map(
              (shop, idx) => [shop.npcEid, second.shops[idx]!.npcEid] as [number, number],
            ),
          ];
          for (const [eidA, eidB] of npcPairs) {
            expect(firstWorld.stores.position.x[eidA]).toBe(secondWorld.stores.position.x[eidB]);
            expect(firstWorld.stores.position.y[eidA]).toBe(secondWorld.stores.position.y[eidB]);
          }

          const settlementDoors = first.settlementRoomIds.flatMap(
            (roomId) => firstWorld.floorMap!.roomGraph.get(roomId)?.doors ?? [],
          );
          const npcEids = [
            first.brokerEid,
            first.defectorEid,
            first.quartermasterShop.npcEid,
            ...first.shops.map((shop) => shop.npcEid),
          ];
          for (const eid of npcEids) {
            const tile = firstWorld.floorMap!.worldToTile(
              firstWorld.stores.position.x[eid] ?? 0,
              firstWorld.stores.position.y[eid] ?? 0,
            );
            expect(
              settlementDoors.every(
                (door) =>
                  Math.max(Math.abs(tile.x - door.x), Math.abs(tile.y - door.y)) >
                  FLOOR2_SETTLEMENT_DOOR_BUFFER_TILES,
              ),
            ).toBe(true);
          }
        },
      ),
      { numRuns: 60, seed: 42 },
    );
  }, 120_000);
});
