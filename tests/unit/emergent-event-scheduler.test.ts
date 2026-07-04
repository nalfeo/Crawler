/**
 * Slice 6 · Unit tests for `emergentEventSystem` — the seeded emergent-event
 * scheduler. Verifies each trigger type (timer / regionEnter / threshold),
 * one-shot enforcement (no re-fire), and deterministic behaviour under a
 * fixed seed.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  asFamilyId,
  initializeFactionRelations,
  adjustFactionRelation,
  bandFor,
  type FamilyId,
} from '../../src/core/faction-relations.js';
import {
  emergentEventSystem,
  getFiredEmergentEvents,
  forceFireEmergentEvent,
  _resetEmergentEventScheduler,
} from '../../src/game/systems/emergentEventSystem.js';
import { _resetEmergentEventCache } from '../../src/shared/data/emergent-events.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { BiomeType, RoomRole, TilePresets } from '../../src/shared/map-types.js';

function makeSettlementMap(): FloorMap {
  const config = {
    widthTiles: 20,
    heightTiles: 20,
    tileSizeFt: 32,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 8] as [number, number],
    roomHeightRange: [4, 8] as [number, number],
    maxRooms: 4,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(20, 20);
  tileMap.fill(TilePresets.FLOOR);
  const graph = new RoomGraph();
  graph.add({ x: 1, y: 1, width: 4, height: 4 }, [], [], RoomRole.SETTLEMENT);
  return new FloorMap(config, tileMap, graph, new Uint8Array(20 * 20), { x: 2, y: 2 });
}

function seedFloor2State(world: ReturnType<typeof createTestWorld>, families: FamilyId[]) {
  world.floor2State = {
    presentFamilies: families,
    contestedResource: 'gold-veins' as ReturnType<typeof asFamilyId> as never,
    betrayerFlag: false,
  } as never;
  initializeFactionRelations(world, families);
}

const FAM_A = asFamilyId('family-a');
const FAM_B = asFamilyId('family-b');
const FAM_C = asFamilyId('family-c');
const FAM_D = asFamilyId('family-d');

describe('emergentEventSystem · gating', () => {
  beforeEach(() => {
    _resetEmergentEventScheduler();
    _resetEmergentEventCache();
  });

  it('no-op when floor2State is null', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    world.elapsedMs = 1_000_000;
    emergentEventSystem(world);
    expect(getFiredEmergentEvents(world).size).toBe(0);
  });

  it('no-op when state !== "playing"', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    seedFloor2State(world, [FAM_A, FAM_B, FAM_C, FAM_D]);
    world.state = 'paused';
    world.elapsedMs = 1_000_000;
    emergentEventSystem(world);
    expect(getFiredEmergentEvents(world).size).toBe(0);
  });
});

describe('emergentEventSystem · timer trigger', () => {
  beforeEach(() => {
    _resetEmergentEventScheduler();
    _resetEmergentEventCache();
  });

  it('fires once the timer elapses; drops deltas onto the queue', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    seedFloor2State(world, [FAM_A, FAM_B, FAM_C, FAM_D]);
    world.state = 'playing';
    // The turf-war-flashpoint timer sits at 45_000ms.
    world.elapsedMs = 45_000;
    emergentEventSystem(world);
    expect(getFiredEmergentEvents(world).has('floor2-event-turf-war-flashpoint')).toBe(true);
    expect(world.factionRelationDeltas.length).toBeGreaterThan(0);
  });

  it('one-shot enforcement — same event does not re-fire across ticks', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    seedFloor2State(world, [FAM_A, FAM_B, FAM_C, FAM_D]);
    world.state = 'playing';
    world.elapsedMs = 45_000;
    emergentEventSystem(world);
    const firstDrainSize = world.factionRelationDeltas.length;
    world.factionRelationDeltas.length = 0;
    world.elapsedMs = 200_000;
    emergentEventSystem(world);
    // Only later-timer events (like poison-the-well at 120_000ms) should fire,
    // not the turf-war one that already fired. The queue may have OTHER
    // events' deltas — but nothing from the turf-war event.
    const turfWarDeltas = world.factionRelationDeltas.filter((d) =>
      d.reason.startsWith('floor2-event-turf-war-flashpoint'),
    );
    expect(turfWarDeltas.length).toBe(0);
    expect(firstDrainSize).toBeGreaterThan(0);
  });
});

describe('emergentEventSystem · threshold trigger', () => {
  beforeEach(() => {
    _resetEmergentEventScheduler();
    _resetEmergentEventCache();
  });

  it('fires when family[0] crosses into hate band', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    seedFloor2State(world, [FAM_A, FAM_B, FAM_C, FAM_D]);
    world.state = 'playing';
    world.elapsedMs = 100;
    // First tick: register the initial band (DEFAULT_RELATION=45 sits in "hostile").
    emergentEventSystem(world);
    world.factionRelationEvents.length = 0;
    world.factionRelationDeltas.length = 0;
    // Cross from "hostile" → "hate" (45 → 20 sits in the hate band).
    adjustFactionRelation(world, FAM_A, -25);
    expect(bandFor(world.factionRelations.get(FAM_A)!)).toBe('hate');
    world.elapsedMs = 200;
    emergentEventSystem(world);
    // "The Betrayal Tax" is the threshold event authored to fire on
    // family[0] crossing into 'hate'.
    expect(getFiredEmergentEvents(world).has('floor2-event-betrayal-tax')).toBe(true);
  });
});

describe('emergentEventSystem · forceFire helper (lab/test parity)', () => {
  beforeEach(() => {
    _resetEmergentEventScheduler();
    _resetEmergentEventCache();
  });

  it('force-fires a named event and marks it fired', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    seedFloor2State(world, [FAM_A, FAM_B, FAM_C, FAM_D]);
    world.state = 'playing';
    const ok = forceFireEmergentEvent(world, 'floor2-event-tribute-run');
    expect(ok).toBe(true);
    expect(getFiredEmergentEvents(world).has('floor2-event-tribute-run')).toBe(true);
    expect(world.factionRelationDeltas.length).toBeGreaterThan(0);
  });

  it('returns false for an unknown event id', () => {
    const world = createTestWorld();
    spawnPlayer(world, 0, 0);
    seedFloor2State(world, [FAM_A, FAM_B, FAM_C, FAM_D]);
    expect(forceFireEmergentEvent(world, 'not-a-real-event')).toBe(false);
  });
});

describe('emergentEventSystem · determinism', () => {
  beforeEach(() => {
    _resetEmergentEventScheduler();
    _resetEmergentEventCache();
  });

  it('same seed + inputs ⇒ identical fired-event ordering and delta list', () => {
    function run(seed: number) {
      const world = createTestWorld({ seed });
      spawnPlayer(world, 0, 0);
      seedFloor2State(world, [FAM_A, FAM_B, FAM_C, FAM_D]);
      world.state = 'playing';
      world.elapsedMs = 45_000;
      emergentEventSystem(world);
      const fired = [...getFiredEmergentEvents(world)].sort();
      const deltaReasons = world.factionRelationDeltas.map((d) => d.reason).sort();
      _resetEmergentEventScheduler(world);
      return { fired, deltaReasons };
    }
    const a = run(1234);
    const b = run(1234);
    expect(a).toEqual(b);
  });
});

describe('emergentEventSystem · regionEnter trigger', () => {
  beforeEach(() => {
    _resetEmergentEventScheduler();
    _resetEmergentEventCache();
  });

  it('fires tribute-run when player enters a settlement room', () => {
    const world = createTestWorld();
    const player = spawnPlayer(world, 0, 0);
    seedFloor2State(world, [FAM_A, FAM_B, FAM_C, FAM_D]);
    world.state = 'playing';
    world.elapsedMs = 100;

    // Place player inside the settlement room (tile 2,2 = feet 64,64 with tileSizeFt=32)
    world.floorMap = makeSettlementMap();
    world.stores.position.x[player] = 64;
    world.stores.position.y[player] = 64;

    emergentEventSystem(world);

    expect(getFiredEmergentEvents(world).has('floor2-event-tribute-run')).toBe(true);
  });
});
