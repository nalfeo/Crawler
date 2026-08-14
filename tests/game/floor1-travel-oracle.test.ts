import { addComponent, addEntity, set } from 'bitecs';
import { beforeEach, describe, expect, it } from 'vitest';
import { setDoorLockConfig } from '../../src/core/door-lock.js';
import { DoorState } from '../../src/core/components.js';
import { makeMapWithDoor, makePathMap } from '../helpers/map-fixtures.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { IN_PLACE_LOCATION } from '../../src/game/ai/objective-route-planner.js';
import { makeFloor1DoorAwareTravelOracle } from '../../src/game/ai/floor1-travel-oracle.js';
import { PATH_TRAVERSAL } from '../../src/core/map/pathfinding.js';
import type { GameWorld } from '../../src/core/world.js';
import type { FloorScenarioState } from '../../src/shared/floor-types.js';
import { TilePresets } from '../../src/shared/map-types.js';

const UNLOCK_GOAL_ID = 'test-unlock-goal';

function spawnLockedDoor(world: GameWorld, tileX: number, tileY: number): number {
  const eid = addEntity(world.ecs);
  addComponent(world.ecs, eid, set(DoorState, { tileX, tileY, logicalOpen: 0, isLocked: 1 }));
  setDoorLockConfig(world, eid, {
    unlock: { operator: 'all', conditions: [{ type: 'goal', goalId: UNLOCK_GOAL_ID }] },
  });
  return eid;
}

describe('makeFloor1DoorAwareTravelOracle', () => {
  let world: GameWorld;
  const west = { x: 2 * 32 + 16, y: 4 * 32 + 16 }; // tile ~(2,4), west of the pillar
  const east = { x: 9 * 32 + 16, y: 4 * 32 + 16 }; // tile ~(9,4), east of the pillar
  const locations = new Map([
    ['west', west],
    ['east', east],
  ]);

  beforeEach(() => {
    world = createTestWorld({ seed: 42 });
    // 12x9 arena split by a full-height pillar at x=6, pierced only by a door
    // at tile (6,4) — the only connection between the west and east halves.
    world.floorMap = makePathMap(false);
    spawnLockedDoor(world, 6, 4);
  });

  function makeOracle() {
    return makeFloor1DoorAwareTravelOracle(world, locations, {
      moveSpeedFtPerMs: 0.12,
      pathOptions: { traversalMode: PATH_TRAVERSAL.GROUND },
    });
  }

  it('returns Infinity — strictly, never a Euclidean guess — while the only connecting door is locked', () => {
    const oracle = makeOracle();
    const cost = oracle.travelCost('west', 'east', new Set());
    expect(cost).toBe(Infinity);
  });

  it('treats the door as open once the hypothetical satisfied-effects set includes its unlock goal, WITHOUT mutating live world state', () => {
    const oracle = makeOracle();
    const cost = oracle.travelCost('west', 'east', new Set([UNLOCK_GOAL_ID]));
    expect(Number.isFinite(cost)).toBe(true);
    expect(cost).toBeGreaterThan(0);
    // The hypothetical override must not have touched live goal-flag state.
    expect(world.goalFlags.get(UNLOCK_GOAL_ID)).not.toBe(true);
  });

  it('still returns Infinity for a DIFFERENT (unrelated) satisfied effect', () => {
    const oracle = makeOracle();
    const cost = oracle.travelCost('west', 'east', new Set(['some-other-goal']));
    expect(cost).toBe(Infinity);
  });

  it('treats IN_PLACE_LOCATION as zero-cost regardless of door state', () => {
    const oracle = makeOracle();
    expect(oracle.travelCost('west', IN_PLACE_LOCATION, new Set())).toBe(0);
  });

  it('returns Infinity when there is no floor map', () => {
    world.floorMap = null;
    const oracle = makeOracle();
    expect(oracle.travelCost('west', 'east', new Set([UNLOCK_GOAL_ID]))).toBe(Infinity);
  });

  it('returns Infinity for an unknown location id', () => {
    const oracle = makeOracle();
    expect(oracle.travelCost('west', 'nowhere', new Set([UNLOCK_GOAL_ID]))).toBe(Infinity);
  });

  it('returns 0 for a same-location travel request', () => {
    const oracle = makeOracle();
    expect(oracle.travelCost('west', 'west', new Set())).toBe(0);
  });

  it('produces an integer cost consistent with tile-hop distance / speed', () => {
    const oracle = makeOracle();
    const cost = oracle.travelCost('west', 'east', new Set([UNLOCK_GOAL_ID]));
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('is unaffected by an unrelated open map with no dividing door (sanity: finite without any override)', () => {
    world.floorMap = makeMapWithDoor();
    const openLocations = new Map([
      ['a', { x: 2 * 32 + 16, y: 2 * 32 + 16 }],
      ['b', { x: 7 * 32 + 16, y: 7 * 32 + 16 }],
    ]);
    const oracle = makeFloor1DoorAwareTravelOracle(world, openLocations, {
      moveSpeedFtPerMs: 0.12,
      pathOptions: { traversalMode: PATH_TRAVERSAL.GROUND },
    });
    expect(Number.isFinite(oracle.travelCost('a', 'b', new Set()))).toBe(true);
  });

  it('recovers a blocked live-player start from physically overlapped cardinal floor', () => {
    world.floorMap = makePathMap(false);
    const boundaryLocations = new Map([
      ['player', { x: 6 * 32, y: 3 * 32 + 16 }],
      ['goal', west],
    ]);
    const oracle = makeFloor1DoorAwareTravelOracle(world, boundaryLocations, {
      moveSpeedFtPerMs: 0.12,
      pathOptions: { traversalMode: PATH_TRAVERSAL.GROUND },
      blockedStartRecovery: { locationId: 'player', bodyRadiusFt: 1.5 },
    });

    expect(Number.isFinite(oracle.travelCost('player', 'goal', new Set()))).toBe(true);
  });

  it('uses any reachable physically overlapped cardinal start', () => {
    world.floorMap = makeMapWithDoor();
    const tileMap = world.floorMap.tileMap;
    tileMap.setFlags(5, 5, TilePresets.WALL);
    tileMap.setFlags(3, 5, TilePresets.WALL);
    tileMap.setFlags(4, 4, TilePresets.WALL);
    tileMap.setFlags(4, 6, TilePresets.WALL);
    const cornerLocations = new Map([
      ['player', { x: 5 * 32, y: 5 * 32 }],
      ['goal', { x: 7 * 32 + 16, y: 4 * 32 + 16 }],
    ]);
    const oracle = makeFloor1DoorAwareTravelOracle(world, cornerLocations, {
      moveSpeedFtPerMs: 0.12,
      pathOptions: { traversalMode: PATH_TRAVERSAL.GROUND },
      blockedStartRecovery: { locationId: 'player', bodyRadiusFt: 1.5 },
    });

    expect(Number.isFinite(oracle.travelCost('player', 'goal', new Set()))).toBe(true);
  });

  it('does not recover through a diagonal-only opening', () => {
    world.floorMap = makeMapWithDoor();
    const tileMap = world.floorMap.tileMap;
    tileMap.setFlags(5, 5, TilePresets.WALL);
    tileMap.setFlags(4, 5, TilePresets.WALL);
    tileMap.setFlags(6, 5, TilePresets.WALL);
    tileMap.setFlags(5, 4, TilePresets.WALL);
    tileMap.setFlags(5, 6, TilePresets.WALL);
    const diagonalLocations = new Map([
      ['player', { x: 5 * 32, y: 5 * 32 }],
      ['goal', { x: 4 * 32 + 16, y: 4 * 32 + 16 }],
    ]);
    const oracle = makeFloor1DoorAwareTravelOracle(world, diagonalLocations, {
      moveSpeedFtPerMs: 0.12,
      pathOptions: { traversalMode: PATH_TRAVERSAL.GROUND },
      blockedStartRecovery: { locationId: 'player', bodyRadiusFt: 2 },
    });

    expect(oracle.travelCost('player', 'goal', new Set())).toBe(Infinity);
  });

  it('does not recover an unconfigured blocked start', () => {
    world.floorMap = makePathMap(false);
    const boundaryLocations = new Map([
      ['detour', { x: 6 * 32, y: 3 * 32 + 16 }],
      ['goal', west],
    ]);
    const oracle = makeFloor1DoorAwareTravelOracle(world, boundaryLocations, {
      moveSpeedFtPerMs: 0.12,
      pathOptions: { traversalMode: PATH_TRAVERSAL.GROUND },
      blockedStartRecovery: { locationId: 'player', bodyRadiusFt: 1.5 },
    });

    expect(oracle.travelCost('detour', 'goal', new Set())).toBe(Infinity);
  });

  it('does not use blocked-start recovery to cross a locked door', () => {
    const doorBoundaryLocations = new Map([
      ['player', { x: 6 * 32, y: 4 * 32 + 16 }],
      ['goal', east],
    ]);
    const oracle = makeFloor1DoorAwareTravelOracle(world, doorBoundaryLocations, {
      moveSpeedFtPerMs: 0.12,
      pathOptions: { traversalMode: PATH_TRAVERSAL.GROUND },
      blockedStartRecovery: { locationId: 'player', bodyRadiusFt: 1.5 },
    });

    expect(oracle.travelCost('player', 'goal', new Set())).toBe(Infinity);
  });

  it('floor1-slime-rat-room-open effect forces slime-rat boss-room door tiles passable, enabling exit-to-claim-spell-reward routing', () => {
    // Same divided-map layout: west locked from east by a single door at tile (6,4).
    // Register that door as the slime-rat boss-room door.  Without the effect the
    // route must be Infinity; with `floor1-slime-rat-room-open` the door tile is
    // forced passable, making the route finite.
    world.floorMap = makePathMap(false);
    const doorEid = addEntity(world.ecs);
    addComponent(
      world.ecs,
      doorEid,
      set(DoorState, { tileX: 6, tileY: 4, logicalOpen: 0, isLocked: 1 }),
    );
    // Lock it on the spell-complete goal (what the runtime sets when the fight starts).
    setDoorLockConfig(world, doorEid, {
      unlock: {
        operator: 'all',
        conditions: [{ type: 'goal', goalId: 'floor1-boss-battle-complete' }],
      },
      relock: {
        operator: 'all',
        conditions: [{ type: 'goal', goalId: 'floor1-boss-battle-active' }],
      },
    });
    // Wire the scenario so the oracle knows which door belongs to the slime-rat room.
    world.floorScenario = {
      bossRoomDoorEids: new Map([['slime-rat', [doorEid]]]),
    } as unknown as FloorScenarioState;

    const oracle = makeFloor1DoorAwareTravelOracle(world, locations, {
      moveSpeedFtPerMs: 0.12,
      pathOptions: { traversalMode: PATH_TRAVERSAL.GROUND },
    });

    // No hypothetical effects: door is locked → Infinity.
    expect(oracle.travelCost('west', 'east', new Set())).toBe(Infinity);

    // After hypothetical defeat (slime-rat-room-open) the room door tile is
    // forced passable so the agent can route from inside the room to claim-spell-reward.
    const costWithRoomOpen = oracle.travelCost(
      'west',
      'east',
      new Set(['floor1-slime-rat-room-open']),
    );
    expect(Number.isFinite(costWithRoomOpen)).toBe(true);
    expect(costWithRoomOpen).toBeGreaterThan(0);

    // The live world state must remain unchanged — no goalFlag mutations.
    expect(world.goalFlags.get('floor1-boss-battle-complete')).not.toBe(true);
  });
});
