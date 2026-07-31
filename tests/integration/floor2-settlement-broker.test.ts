/**
 * Slice 6 · Integration — settlement + shops + Broker spawn via
 * `initializeFloor2Settlement`, and the emergent-event scheduler + wiring
 * apply a real relation shift end-to-end.
 *
 * This mirrors the "wired-and-observed" pattern from
 * `tests/integration/family-relationship-wiring.test.ts` (rule #10): we run
 * the actual pipelines rather than call the systems by hand.
 */
import { query } from 'bitecs';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType, RoomRole, TilePresets } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { getGenerator } from '../../src/core/map/generators/registry.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  asFamilyId,
  initializeFactionRelations,
  DEFAULT_RELATION,
  type FamilyId,
} from '../../src/core/faction-relations.js';
import {
  initializeFloor2Settlement,
  QUARTERMASTER_ARCHETYPE_ID,
} from '../../src/game/floor2Settlement.js';
import * as shopArchetypes from '../../src/shared/data/shop-archetypes.js';
import { DoorState } from '../../src/core/components.js';
import { floodFill } from '../../src/core/map/grid-utils.js';
import {
  getFloor2FamilyEliteArchetype,
  getFloor2FamilyFallbackArchetype,
} from '../../src/shared/enemy-packs.js';
import { buildFloor2DefectorDialogue } from '../../src/shared/npc-types.js';
import {
  forceFireEmergentEvent,
  _resetEmergentEventScheduler,
} from '../../src/game/systems/emergentEventSystem.js';
import { _resetEmergentEventCache } from '../../src/shared/data/emergent-events.js';
import { runSimulationStep as runHeadlessStep } from '../../src/game/ai/simulation-step.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { createInputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { purchaseQuartermasterOffer } from '../../src/core/quartermaster-purchase.js';
import { getGeneratedEquipmentInstance } from '../../src/core/generated-equipment-registry.js';
import { listGeneratedEquipmentReferences } from '../../src/shared/inventory.js';

const WIDTH = 120;
const HEIGHT = 90;

function buildFloor2Map() {
  const seed = 4242;
  const gen = getGenerator(BiomeType.CAVE_SYSTEM);
  const cfg: MapConfig = {
    widthTiles: WIDTH,
    heightTiles: HEIGHT,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [7, 12],
    roomHeightRange: [6, 10],
    maxRooms: 35,
    floorDensity: 0.45,
  };
  return gen.generate(cfg, new SeededRandom(seed));
}

const FAMS: FamilyId[] = [
  asFamilyId('family-a'),
  asFamilyId('family-b'),
  asFamilyId('family-c'),
  asFamilyId('family-d'),
];

describe('Floor 2 settlement · initialization', () => {
  const presentFamilies: FamilyId[] = [
    asFamilyId('goblins'),
    asFamilyId('crabfolk'),
    asFamilyId('imps'),
  ];

  function seedSettlementFamilyState(world: ReturnType<typeof createTestWorld>) {
    world.floorExtendedState = {
      ...(world.floorExtendedState ?? {}),
      familyState: {
        presentFamilies: [...presentFamilies],
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
      },
    };
  }

  beforeEach(() => {
    _resetEmergentEventScheduler();
    _resetEmergentEventCache();
  });

  it('spawns the Broker, a family defector, and 1-2 shops inside the settlement cluster', () => {
    const world = createTestWorld({ seed: 999 });
    world.floorMap = buildFloor2Map();
    const playerEid = spawnPlayer(world, 0, 0);
    world.floor = 2;
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    world.floor2EquipmentFlags.floor2EquipmentCatalog = true;
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
    seedSettlementFamilyState(world);

    const snap = initializeFloor2Settlement(world, { shopCount: 2 });
    expect(snap.brokerEid).toBeGreaterThan(0);
    expect(snap.defectorEid).toBeGreaterThan(0);
    expect(presentFamilies).toContain(snap.defectorFamilyId as FamilyId);
    expect(snap.settlementRoomIds.length).toBeGreaterThanOrEqual(2);
    expect(snap.settlementRoomIds.length).toBeLessThanOrEqual(3);

    // Guaranteed Quartermaster.
    expect(snap.quartermasterShop.archetypeId).toBe(QUARTERMASTER_ARCHETYPE_ID);
    expect(snap.quartermasterShop.npcEid).toBeGreaterThan(0);
    expect(snap.quartermasterShop.inventory.length).toBeGreaterThan(0);
    for (const item of snap.quartermasterShop.inventory) {
      expect(item.unitPrice).toBeGreaterThanOrEqual(1);
    }
    expect(snap.quartermasterStock).toBeDefined();
    const quartermasterStock = snap.quartermasterStock!;
    expect(quartermasterStock.offers.length).toBeGreaterThanOrEqual(3);
    expect(quartermasterStock.offers.length).toBeLessThanOrEqual(4);
    const generatedOffer = quartermasterStock.offers[0]!;
    const generatedInstance = getGeneratedEquipmentInstance(world, generatedOffer.instanceId);
    expect(generatedInstance).toBeDefined();
    world.playerGold = generatedOffer.unitPrice;
    expect(
      purchaseQuartermasterOffer(world, playerEid, {
        stockId: quartermasterStock.stockId,
        offerId: generatedOffer.offerId,
        quantity: 1,
      }),
    ).toEqual({
      ok: true,
      instanceId: generatedOffer.instanceId,
      goldSpent: generatedOffer.unitPrice,
      remainingGold: 0,
    });
    const bagAfterPurchase = world.inventories.get(playerEid);
    expect(
      bagAfterPurchase ? listGeneratedEquipmentReferences(bagAfterPurchase) : undefined,
    ).toEqual([{ kind: 'generated-instance', instanceKey: generatedOffer.instanceId }]);
    expect(getGeneratedEquipmentInstance(world, generatedOffer.instanceId)).toBe(generatedInstance);

    // Non-Quartermaster shops (1–2 seeded).
    expect(snap.shops.length).toBe(2);
    for (const shop of snap.shops) {
      expect(shop.npcEid).toBeGreaterThan(0);
      expect(shop.inventory.length).toBeGreaterThan(0);
      for (const item of shop.inventory) {
        expect(item.unitPrice).toBeGreaterThanOrEqual(1);
      }
    }

    const elite = getFloor2FamilyEliteArchetype(snap.defectorFamilyId);
    const fallback = getFloor2FamilyFallbackArchetype(snap.defectorFamilyId);
    expect(elite?.id ?? fallback?.id).toBe(snap.defectorAppearanceKey);
    expect(fallback?.id).toBe(snap.defectorFallbackAppearanceKey);
    expect(world.enemyAppearanceKeys.get(snap.defectorEid)).toBe(snap.defectorAppearanceKey);
    const defectorInstance = world.npcs.get(snap.defectorEid);
    expect(defectorInstance?.appearanceFallbackKey).toBe(snap.defectorFallbackAppearanceKey);
    expect(defectorInstance?.dialogueOverride).toEqual(
      buildFloor2DefectorDialogue(snap.defectorFamilyId),
    );

    // Settlement cluster rooms are retagged SAFE.
    const settlementRooms = snap.settlementRoomIds
      .map((id) => world.floorMap!.roomGraph.get(id))
      .filter((room): room is NonNullable<typeof room> => room != null);
    expect(settlementRooms.length).toBe(snap.settlementRoomIds.length);
    for (const room of settlementRooms) {
      expect(room.role).toBe(RoomRole.SAFE);
    }

    const settlementDoors = settlementRooms.flatMap((room) => room.doors);
    const doorKey = (x: number, y: number) => `${x},${y}`;
    const expectedDoorKeys = new Set(settlementDoors.map((door) => doorKey(door.x, door.y)));
    const seenDoorKeys = new Set<string>();
    for (const eid of query(world.ecs, [DoorState])) {
      const tx = world.stores.doorState.tileX[eid] ?? -1;
      const ty = world.stores.doorState.tileY[eid] ?? -1;
      const key = doorKey(tx, ty);
      if (!expectedDoorKeys.has(key)) continue;
      expect(world.stores.doorState.isLocked[eid]).toBe(0);
      expect(world.stores.doorState.logicalOpen[eid]).toBe(1);
      seenDoorKeys.add(key);
    }
    expect(seenDoorKeys).toEqual(expectedDoorKeys);

    const settlementDoorTiles = settlementRooms.flatMap((room) => room.doors);
    const width = world.floorMap.config.widthTiles;
    const height = world.floorMap.config.heightTiles;
    const reachable = floodFill(
      world.floorMap.playerSpawn.y * width + world.floorMap.playerSpawn.x,
      width,
      height,
      (index) => world.floorMap!.tileMap.isPassable(index % width, Math.floor(index / width)),
    );
    const npcEids = [
      snap.brokerEid,
      snap.defectorEid,
      snap.quartermasterShop.npcEid,
      ...snap.shops.map((shop) => shop.npcEid),
    ];
    const npcTiles = npcEids.map((eid) => {
      const tile = world.floorMap!.worldToTile(
        world.stores.position.x[eid] ?? 0,
        world.stores.position.y[eid] ?? 0,
      );
      const roomId = world.floorMap!.roomGraph.getRoomAt(tile.x, tile.y);
      expect(roomId).toBeGreaterThanOrEqual(0);
      expect(snap.settlementRoomIds).toContain(roomId);
      expect(reachable[tile.y * width + tile.x]).toBe(1);
      expect(
        settlementDoorTiles.some(
          (door) => Math.max(Math.abs(tile.x - door.x), Math.abs(tile.y - door.y)) <= 1,
        ),
      ).toBe(false);
      return tile;
    });
    for (let i = 0; i < npcTiles.length; i += 1) {
      for (let j = i + 1; j < npcTiles.length; j += 1) {
        expect(
          Math.hypot(npcTiles[i]!.x - npcTiles[j]!.x, npcTiles[i]!.y - npcTiles[j]!.y),
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('is idempotent — a second call returns the same snapshot', () => {
    const world = createTestWorld({ seed: 999 });
    world.floorMap = buildFloor2Map();
    spawnPlayer(world, 0, 0);
    world.floor = 2;
    seedSettlementFamilyState(world);

    const first = initializeFloor2Settlement(world);
    const second = initializeFloor2Settlement(world);
    expect(second).toBe(first);
  });

  it('shop rolls are seeded — same world seed ⇒ same inventories', () => {
    function run() {
      const world = createTestWorld({ seed: 12345 });
      world.floorMap = buildFloor2Map();
      spawnPlayer(world, 0, 0);
      world.floor = 2;
      seedSettlementFamilyState(world);
      return initializeFloor2Settlement(world, { shopCount: 2 });
    }
    const a = run();
    const b = run();
    expect(a.defectorFamilyId).toEqual(b.defectorFamilyId);
    expect(a.shops.map((s) => s.archetypeId)).toEqual(b.shops.map((s) => s.archetypeId));
    expect(a.shops.map((s) => s.inventory)).toEqual(b.shops.map((s) => s.inventory));
    // Guaranteed Quartermaster is also deterministic.
    expect(a.quartermasterShop.archetypeId).toEqual(b.quartermasterShop.archetypeId);
    expect(a.quartermasterShop.inventory).toEqual(b.quartermasterShop.inventory);
  });

  it('Quartermaster is never selected from the random shop pool', () => {
    // Run several different seeds and verify the non-QM shops array never
    // contains the Quartermaster archetype id.
    const seeds = [1, 2, 3, 42, 100, 999, 12345];
    for (const seed of seeds) {
      const world = createTestWorld({ seed });
      world.floorMap = buildFloor2Map();
      spawnPlayer(world, 0, 0);
      world.floor = 2;
      seedSettlementFamilyState(world);
      const snap = initializeFloor2Settlement(world);
      for (const shop of snap.shops) {
        expect(shop.archetypeId).not.toBe(QUARTERMASTER_ARCHETYPE_ID);
      }
      // Exactly one Quartermaster guaranteed.
      expect(snap.quartermasterShop.archetypeId).toBe(QUARTERMASTER_ARCHETYPE_ID);
    }
  });
  it('throws actionably when the archetype pool contains only the Quartermaster (empty random pool)', () => {
    const world = createTestWorld({ seed: 42 });
    world.floorMap = buildFloor2Map();
    spawnPlayer(world, 0, 0);
    world.floor = 2;
    seedSettlementFamilyState(world);
    const onlyQm = shopArchetypes
      .loadShopArchetypes()
      .filter((a) => a.id === QUARTERMASTER_ARCHETYPE_ID);
    expect(() => initializeFloor2Settlement(world, { archetypes: onlyQm })).toThrowError(
      /requires \d+ non-Quartermaster shop archetypes, found 0/,
    );
  });

  it('throws actionably when the canonical archetype list is missing the Quartermaster', () => {
    const world = createTestWorld({ seed: 42 });
    world.floorMap = buildFloor2Map();
    spawnPlayer(world, 0, 0);
    world.floor = 2;
    seedSettlementFamilyState(world);

    const canonicalWithoutQm = shopArchetypes
      .loadShopArchetypes()
      .filter((a) => a.id !== QUARTERMASTER_ARCHETYPE_ID);
    const loadSpy = vi
      .spyOn(shopArchetypes, 'loadShopArchetypes')
      .mockReturnValue(canonicalWithoutQm);

    try {
      expect(() => initializeFloor2Settlement(world)).toThrowError(
        new RegExp(`canonical "${QUARTERMASTER_ARCHETYPE_ID}" archetype not found`),
      );
      expect(loadSpy).toHaveBeenCalled();
    } finally {
      loadSpy.mockRestore();
    }
  });

  it('fails before mutating settlement state when strict placement capacity is unavailable', () => {
    const world = createTestWorld({ seed: 999 });
    world.floorMap = buildFloor2Map();
    spawnPlayer(world, 0, 0);
    world.floor = 2;
    seedSettlementFamilyState(world);

    const settlementRooms = world.floorMap.roomGraph.getRoomsByRole(RoomRole.SETTLEMENT);
    for (const room of settlementRooms) {
      for (const cell of room.interiorCells ?? []) {
        world.floorMap.tileMap.flags[cell.y * WIDTH + cell.x] = TilePresets.WALL;
      }
    }
    const rolesBefore = settlementRooms.map((room) => room.role);
    const terrainBefore = world.floorMap.terrain.slice();
    const doorCountBefore = query(world.ecs, [DoorState]).length;
    const doorArraysBefore = settlementRooms.map((room) => [...room.doors]);
    const tileMapFlagsBefore = world.floorMap.tileMap.flags.slice();

    expect(() => initializeFloor2Settlement(world, { shopCount: 2 })).toThrowError(
      /settlement capacity insufficient; required=5/,
    );
    expect(settlementRooms.map((room) => room.role)).toEqual(rolesBefore);
    expect(world.floorMap.terrain).toEqual(terrainBefore);
    expect(query(world.ecs, [DoorState])).toHaveLength(doorCountBefore);
    expect(settlementRooms.map((room) => [...room.doors])).toEqual(doorArraysBefore);
    expect(world.floorMap.tileMap.flags).toEqual(tileMapFlagsBefore);
    expect(world.floorExtendedState?.settlement).toBeUndefined();
    expect(world.npcs.size).toBe(0);
  });

  it('fails before any RNG or world mutation when economy is enabled with an invalid dependency closure', () => {
    const world = createTestWorld({ seed: 999 });
    world.floorMap = buildFloor2Map();
    spawnPlayer(world, 0, 0);
    world.floor = 2;
    seedSettlementFamilyState(world);

    // Enable economy but omit the required catalog dependency — invalid closure.
    world.floor2EquipmentFlags.floor2EquipmentEconomy = true;
    world.floor2EquipmentFlags.floor2EquipmentRegistry = true;
    // floor2EquipmentCatalog left false.

    const settlementRooms = world.floorMap.roomGraph.getRoomsByRole(RoomRole.SETTLEMENT);
    const rolesBefore = settlementRooms.map((room) => room.role);
    const doorCountBefore = query(world.ecs, [DoorState]).length;

    // Use a control world to verify world.rng is not consumed before the throw.
    const control = createTestWorld({ seed: 999 });

    expect(() => initializeFloor2Settlement(world, { shopCount: 2 })).toThrowError(
      'floor2EquipmentEconomy requires floor2EquipmentRegistry and floor2EquipmentCatalog',
    );

    // No NPCs spawned, no settlement snapshot written.
    expect(world.floorExtendedState?.settlement).toBeUndefined();
    expect(world.npcs.size).toBe(0);
    // No door entities created.
    expect(query(world.ecs, [DoorState])).toHaveLength(doorCountBefore);
    // Settlement room roles unmodified.
    expect(settlementRooms.map((room) => room.role)).toEqual(rolesBefore);
    // world.rng was not advanced — next value matches an untouched control world.
    expect(world.rng.next()).toBe(control.rng.next());
  });
});

describe('Floor 2 emergent events · end-to-end propagation through the pipeline', () => {
  beforeEach(() => {
    _resetEmergentEventScheduler();
    _resetEmergentEventCache();
  });

  it('force-firing an event queues deltas, and the pipeline drain shifts factionRelations', () => {
    const world = createTestWorld({ seed: 7 });
    const player = spawnPlayer(world, 0, 0);
    void player;
    world.floor = 2;
    world.state = 'playing';
    world.floorExtendedState = {
      familyState: {
        presentFamilies: FAMS,
        contestedResource: 'gold-veins' as never,
        betrayerFlag: false,
      } as never,
    };
    initializeFactionRelations(world, FAMS);

    // Baseline: all four families sit at DEFAULT_RELATION.
    for (const fam of FAMS) {
      expect(world.factionRelations.get(fam)).toBe(DEFAULT_RELATION);
    }

    // Fire "The Tribute Run" — indexes 0 in floor2State.presentFamilies.
    forceFireEmergentEvent(world, 'floor2-event-tribute-run');
    expect(world.factionRelationDeltas.length).toBeGreaterThan(0);

    // The headless pipeline includes familyRelationshipSystem AND
    // emergentEventSystem — draining the queue observably. Pass canonical
    // preSystems (the single source of truth for ordering, issue #663).
    const floor2Opts = createFloorMainSceneOptions('floor2');
    runHeadlessStep(world, createInputState(), 16, { preSystems: floor2Opts.preSystems });
    expect(world.factionRelationDeltas).toHaveLength(0);

    // Family index 0 got the tribute-delivered lever (+10 from tuning).
    const famA = world.factionRelations.get(FAMS[0]!)!;
    expect(famA).toBe(DEFAULT_RELATION + 10);
  });
});
