import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { spawnPlayer } from '../../src/core/helpers.js';
import {
  safeRoomSystem,
  isInSafeContext,
  isPointInSafeSpace,
  isPointInClearedArena,
  isEntityInSafeSpace,
} from '../../src/core/safe-space.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { BiomeType, RoomRole } from '../../src/shared/map-types.js';
import type { MapConfig } from '../../src/shared/map-types.js';
import type { GameWorld } from '../../src/core/world.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeMapWithSafeRoom } from '../helpers/map-fixtures.js';
import { equip } from '../../src/core/systems/equipmentSystem.js';
import { MERCHANTS_CHARM_DEF } from '../../src/shared/equipmentDefs.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MAP_CFG: MapConfig = {
  widthTiles: 20,
  heightTiles: 20,
  tileSizeFt: 32,
  biome: BiomeType.DUNGEON,
  seed: 1,
  roomWidthRange: [4, 8],
  roomHeightRange: [4, 8],
  maxRooms: 4,
  floorDensity: 0.5,
};

/** Feet centre of the safe room (tile 3,3 → 3*32+16=112, same for y). */
const SAFE_FT = { x: 3 * 32 + 16, y: 3 * 32 + 16 };
/** Feet centre of the normal room (tile 12,12 → 12*32+16=400). */
const NORMAL_FT = { x: 12 * 32 + 16, y: 12 * 32 + 16 };

// ---------------------------------------------------------------------------
// isPointInSafeSpace
// ---------------------------------------------------------------------------

describe('isPointInSafeSpace', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom({ withNormalRoom: true });
  });

  it('returns true when point is inside the safe room', () => {
    expect(isPointInSafeSpace(world, SAFE_FT.x, SAFE_FT.y)).toBe(true);
  });

  it('returns false when point is in a normal room', () => {
    expect(isPointInSafeSpace(world, NORMAL_FT.x, NORMAL_FT.y)).toBe(false);
  });

  it('returns false when world has no floorMap', () => {
    world.floorMap = null;
    expect(isPointInSafeSpace(world, SAFE_FT.x, SAFE_FT.y)).toBe(false);
  });

  it('returns false when there are no SAFE rooms', () => {
    const graph = new RoomGraph();
    graph.add({ x: 1, y: 1, width: 4, height: 4 }, [], [], RoomRole.NORMAL);
    const tileMap = new TileMap(20, 20);
    world.floorMap = new FloorMap(MAP_CFG, tileMap, graph, new Uint8Array(400), { x: 2, y: 2 });
    expect(isPointInSafeSpace(world, SAFE_FT.x, SAFE_FT.y)).toBe(false);
  });

  it('does NOT treat a cleared boss room as safe space (Floor 1 seed-1 stall)', () => {
    // A cleared arena is a customization/retreat space, never a safe SPACE:
    // `isPointInSafeSpace` disables the player's weapon, keeps enemies out,
    // pauses the collapse deadline and flips the AI into leave-the-safe-room
    // mode. Floor 1's cleared arena owns the staircase, so answering true here
    // stalled the run beside its own exit. Room 1 is the NORMAL room the
    // fixture puts at tiles (10,10)-(13,13).
    world.clearedSafeRoomIds.add(1);
    world.clearedSafeRoomMap = world.floorMap;
    expect(isPointInSafeSpace(world, NORMAL_FT.x, NORMAL_FT.y)).toBe(false);
  });

  it('uses interiorCells for SAFE caverns instead of bounding-box membership', () => {
    const graph = new RoomGraph();
    graph.add({ x: 1, y: 1, width: 6, height: 6 }, [], [], RoomRole.SAFE, undefined, undefined, [
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 1 },
    ]);
    const tileMap = new TileMap(20, 20);
    world.floorMap = new FloorMap(MAP_CFG, tileMap, graph, new Uint8Array(400), { x: 2, y: 2 });

    const insideBoundsButOutsideInterior = { x: 3 * 32 + 16, y: 3 * 32 + 16 }; // tile (3,3)
    expect(
      isPointInSafeSpace(world, insideBoundsButOutsideInterior.x, insideBoundsButOutsideInterior.y),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPointInClearedArena
// ---------------------------------------------------------------------------

describe('isPointInClearedArena', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom({ withNormalRoom: true });
  });

  it('reports a cleared boss room (issue #3275 item 5)', () => {
    expect(isPointInClearedArena(world, NORMAL_FT.x, NORMAL_FT.y)).toBe(false);
    world.clearedSafeRoomIds.add(1);
    world.clearedSafeRoomMap = world.floorMap;
    expect(isPointInClearedArena(world, NORMAL_FT.x, NORMAL_FT.y)).toBe(true);
  });

  it('ignores cleared room ids recorded against a different floor', () => {
    // Room ids are unique only within one generated floor: a cleared Floor 1
    // arena must never make the same-numbered room on the next floor count.
    world.clearedSafeRoomIds.add(1);
    world.clearedSafeRoomMap = null;
    expect(isPointInClearedArena(world, NORMAL_FT.x, NORMAL_FT.y)).toBe(false);
  });

  it('does not cover the rest of the floor when a boss room is cleared', () => {
    world.clearedSafeRoomIds.add(1);
    world.clearedSafeRoomMap = world.floorMap;
    // A corridor tile outside every room stays hostile.
    expect(isPointInClearedArena(world, 8 * 32 + 16, 8 * 32 + 16)).toBe(false);
  });

  it('returns false when the world has no floorMap', () => {
    world.clearedSafeRoomIds.add(1);
    world.clearedSafeRoomMap = null;
    world.floorMap = null;
    expect(isPointInClearedArena(world, NORMAL_FT.x, NORMAL_FT.y)).toBe(false);
  });

  it('reports a cleared boss room while leaving its generated role intact', () => {
    const graph = new RoomGraph();
    const bossRoomId = graph.add(
      { x: 10, y: 10, width: 4, height: 4 },
      [],
      [],
      RoomRole.BOSS_STAIR,
    );
    const tileMap = new TileMap(20, 20);
    world.floorMap = new FloorMap(MAP_CFG, tileMap, graph, new Uint8Array(400), { x: 2, y: 2 });
    world.clearedSafeRoomIds.add(bossRoomId);
    world.clearedSafeRoomMap = world.floorMap;
    expect(isPointInClearedArena(world, NORMAL_FT.x, NORMAL_FT.y)).toBe(true);
    // The cleared room keeps its generated role, so the stairs/minimap
    // consumers that resolve the boss room BY ROLE still find it.
    expect(world.floorMap.bossStairRoom?.id).toBe(bossRoomId);
    // ...and it is still NOT a safe space.
    expect(isPointInSafeSpace(world, NORMAL_FT.x, NORMAL_FT.y)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// safeRoomSystem
// ---------------------------------------------------------------------------

describe('safeRoomSystem', () => {
  let world: GameWorld;
  let playerEid: number;

  beforeEach(() => {
    world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom({ withNormalRoom: true });
    playerEid = spawnPlayer(world, SAFE_FT.x, SAFE_FT.y);
  });

  it('sets playerInSafeRoom=true when player is in a safe room', () => {
    world.state = 'playing';
    safeRoomSystem(world);
    expect(world.playerInSafeRoom).toBe(true);
  });

  it('sets playerInSafeRoom=false when player is outside safe rooms', () => {
    world.stores.position.x[playerEid] = NORMAL_FT.x;
    world.stores.position.y[playerEid] = NORMAL_FT.y;
    world.state = 'playing';
    safeRoomSystem(world);
    expect(world.playerInSafeRoom).toBe(false);
  });

  it('does not run when state is not playing', () => {
    // Start inside safe room but change state — system should be a no-op
    world.playerInSafeRoom = false;
    world.state = 'paused';
    safeRoomSystem(world);
    // Should not have been updated
    expect(world.playerInSafeRoom).toBe(false);
  });

  it('sets playerInSafeRoom=false when no player entity exists', () => {
    world.playerInSafeRoom = true;
    // Create a fresh world with no player
    const emptyWorld = createTestWorld();
    emptyWorld.floorMap = makeMapWithSafeRoom({ withNormalRoom: true });
    emptyWorld.state = 'playing';
    safeRoomSystem(emptyWorld);
    expect(emptyWorld.playerInSafeRoom).toBe(false);
  });

  it('tracks playerInClearedArena without making the arena a safe room', () => {
    world.stores.position.x[playerEid] = NORMAL_FT.x;
    world.stores.position.y[playerEid] = NORMAL_FT.y;
    world.clearedSafeRoomIds.add(1);
    world.clearedSafeRoomMap = world.floorMap;
    world.state = 'playing';
    safeRoomSystem(world);
    expect(world.playerInClearedArena).toBe(true);
    expect(world.playerInSafeRoom).toBe(false);

    // Walking back out of the arena clears the flag again.
    world.stores.position.x[playerEid] = SAFE_FT.x;
    world.stores.position.y[playerEid] = SAFE_FT.y;
    safeRoomSystem(world);
    expect(world.playerInClearedArena).toBe(false);
    expect(world.playerInSafeRoom).toBe(true);
  });

  it('clears playerInClearedArena when no player entity exists', () => {
    const emptyWorld = createTestWorld();
    emptyWorld.floorMap = makeMapWithSafeRoom({ withNormalRoom: true });
    emptyWorld.playerInClearedArena = true;
    emptyWorld.state = 'playing';
    safeRoomSystem(emptyWorld);
    expect(emptyWorld.playerInClearedArena).toBe(false);
  });

  it('updates correctly when player moves between zones', () => {
    world.state = 'playing';

    // Inside safe room
    safeRoomSystem(world);
    expect(world.playerInSafeRoom).toBe(true);

    // Move to normal room
    world.stores.position.x[playerEid] = NORMAL_FT.x;
    world.stores.position.y[playerEid] = NORMAL_FT.y;
    safeRoomSystem(world);
    expect(world.playerInSafeRoom).toBe(false);

    // Move back into safe room
    world.stores.position.x[playerEid] = SAFE_FT.x;
    world.stores.position.y[playerEid] = SAFE_FT.y;
    safeRoomSystem(world);
    expect(world.playerInSafeRoom).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isInSafeContext
// ---------------------------------------------------------------------------

describe('isInSafeContext', () => {
  let world: GameWorld;

  beforeEach(() => {
    world = createTestWorld();
  });

  it('returns true when playerInSafeRoom is true', () => {
    world.playerInSafeRoom = true;
    expect(isInSafeContext(world)).toBe(true);
  });

  it('returns true when state is safe_room (end-of-run)', () => {
    world.playerInSafeRoom = false;
    world.state = 'safe_room';
    expect(isInSafeContext(world)).toBe(true);
  });

  it('returns false during regular play outside a safe room', () => {
    world.playerInSafeRoom = false;
    world.state = 'playing';
    expect(isInSafeContext(world)).toBe(false);
  });

  it('returns true when both flags are true', () => {
    world.playerInSafeRoom = true;
    world.state = 'safe_room';
    expect(isInSafeContext(world)).toBe(true);
  });

  it('returns true inside a cleared boss arena', () => {
    // A cleared arena opens the customization panels (ADR-0091's equip beat)
    // WITHOUT being a safe space — nothing there can still hurt the player.
    world.playerInSafeRoom = false;
    world.playerInClearedArena = true;
    world.state = 'playing';
    expect(isInSafeContext(world)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Equipment gating: only allowed in safe context
// ---------------------------------------------------------------------------

describe('equipment safe-room gate', () => {
  let world: GameWorld;
  let playerEid: number;

  beforeEach(() => {
    world = createTestWorld();
    playerEid = spawnPlayer(world, 0, 0);
    world.featureUnlocks.equipment = true;
  });

  it('rejects equip outside safe context', () => {
    world.playerInSafeRoom = false;
    world.state = 'playing';
    const result = equip(world, playerEid, MERCHANTS_CHARM_DEF);
    expect(result.ok).toBe(false);
  });

  it('allows equip when playerInSafeRoom=true', () => {
    world.playerInSafeRoom = true;
    world.state = 'playing';
    const result = equip(world, playerEid, MERCHANTS_CHARM_DEF);
    expect(result.ok).toBe(true);
  });

  it('allows equip in end-of-run safe_room state', () => {
    world.playerInSafeRoom = false;
    world.state = 'safe_room';
    const result = equip(world, playerEid, MERCHANTS_CHARM_DEF);
    expect(result.ok).toBe(true);
  });

  it('allows equip while standing in a cleared boss arena', () => {
    world.playerInSafeRoom = false;
    world.playerInClearedArena = true;
    world.state = 'playing';
    const result = equip(world, playerEid, MERCHANTS_CHARM_DEF);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property: safeRoomSystem always produces a boolean, never throws
// ---------------------------------------------------------------------------

describe('safeRoomSystem property tests', () => {
  it('never throws regardless of player position', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2000, max: 2000 }),
        fc.integer({ min: -2000, max: 2000 }),
        (px, py) => {
          const world = createTestWorld();
          world.floorMap = makeMapWithSafeRoom({ withNormalRoom: true });
          world.state = 'playing';
          spawnPlayer(world, px, py);
          expect(() => safeRoomSystem(world)).not.toThrow();
          expect(typeof world.playerInSafeRoom).toBe('boolean');
        },
      ),
    );
  });
});

describe('isEntityInSafeSpace', () => {
  it('returns false when the entity has no position (undefined x/y)', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom();
    // Use eid 9999 which was never assigned position data
    expect(isEntityInSafeSpace(world, 9999)).toBe(false);
  });
});
