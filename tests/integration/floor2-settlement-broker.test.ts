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
import { describe, expect, it, beforeEach } from 'vitest';
import { SeededRandom } from '../../src/shared/random.js';
import { BiomeType, RoomRole } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import { getGenerator } from '../../src/core/map/generators/registry.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  asFamilyId,
  initializeFactionRelations,
  DEFAULT_RELATION,
  type FamilyId,
} from '../../src/core/faction-relations.js';
import { initializeFloor2Settlement } from '../../src/game/floor2Settlement.js';
import { DoorState } from '../../src/core/components.js';
import {
  forceFireEmergentEvent,
  _resetEmergentEventScheduler,
} from '../../src/game/systems/emergentEventSystem.js';
import { _resetEmergentEventCache } from '../../src/shared/data/emergent-events.js';
import { runSimulationStep as runHeadlessStep } from '../../src/game/ai/simulation-step.js';
import { createInputState } from '../../src/shared/input.js';
import { createTestWorld } from '../helpers/world-factory.js';

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
  beforeEach(() => {
    _resetEmergentEventScheduler();
    _resetEmergentEventCache();
  });

  it('spawns The Broker + 1-2 shops inside the settlement cluster', () => {
    const world = createTestWorld({ seed: 999 });
    world.floorMap = buildFloor2Map();
    spawnPlayer(world, 0, 0);
    world.floor = 2;

    const snap = initializeFloor2Settlement(world, { shopCount: 2 });
    expect(snap.brokerEid).toBeGreaterThan(0);
    expect(snap.settlementRoomIds.length).toBeGreaterThanOrEqual(2);
    expect(snap.settlementRoomIds.length).toBeLessThanOrEqual(3);
    expect(snap.shops.length).toBe(2);
    for (const shop of snap.shops) {
      expect(shop.npcEid).toBeGreaterThan(0);
      expect(shop.inventory.length).toBeGreaterThan(0);
      for (const item of shop.inventory) {
        expect(item.unitPrice).toBeGreaterThanOrEqual(1);
      }
    }

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
      expect(world.stores.doorState.isOpen[eid]).toBe(1);
      seenDoorKeys.add(key);
    }
    expect(seenDoorKeys).toEqual(expectedDoorKeys);
  });

  it('is idempotent — a second call returns the same snapshot', () => {
    const world = createTestWorld({ seed: 999 });
    world.floorMap = buildFloor2Map();
    spawnPlayer(world, 0, 0);
    world.floor = 2;

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
      return initializeFloor2Settlement(world, { shopCount: 2 });
    }
    const a = run();
    const b = run();
    expect(a.shops.map((s) => s.archetypeId)).toEqual(b.shops.map((s) => s.archetypeId));
    expect(a.shops.map((s) => s.inventory)).toEqual(b.shops.map((s) => s.inventory));
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
    // emergentEventSystem — draining the queue observably.
    runHeadlessStep(world, createInputState(), 16, {});
    expect(world.factionRelationDeltas).toHaveLength(0);

    // Family index 0 got the tribute-delivered lever (+10 from tuning).
    const famA = world.factionRelations.get(FAMS[0]!)!;
    expect(famA).toBe(DEFAULT_RELATION + 10);
  });
});
