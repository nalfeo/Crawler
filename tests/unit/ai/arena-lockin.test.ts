/**
 * Unit tests for `detectArenaLockin` — the pure helper the BT priority slot
 * (1.5) uses to decide whether the AI is currently trapped in a spawner
 * arena or a Floor-1 boss room.
 *
 * Covers every rule from the JSDoc contract:
 *   - open-fence radius check (in / out)
 *   - sealed-room membership (in / adjacent)
 *   - arenaState === 2 (resolved) suppresses the lock-in
 *   - dead spawner (health.current <= 0 OR deathResolved) suppresses it
 *   - Floor-1 boss room lock-in on `bossBattles.started`
 *   - precedence: spawner wins over boss when both hold
 *   - deterministic tie-break: lowest eid wins
 */

import { describe, expect, it } from 'vitest';
import { detectArenaLockin } from '../../../src/game/ai/arena-lockin.js';
import { spawnPlayer, spawnSpawner, spawnEnemy } from '../../../src/core/spawners/combatants.js';
import {
  getSpawnerArchetype,
  getSpawnerArchetypeIndex,
} from '../../../src/game/spawners/registry.js';
import { createTestWorld } from '../../helpers/world-factory.js';
import { FloorMap } from '../../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../../src/core/map/RoomGraph.js';
import { TileMap } from '../../../src/core/map/TileMap.js';
import { BiomeType, RoomRole, TilePresets, type MapConfig } from '../../../src/shared/map-types.js';
import type { FloorScenarioState } from '../../../src/shared/floor-types.js';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

/** Build a floor map with two adjacent rooms, each 6x6, for sealed tests. */
function makeTwoRoomMap(): FloorMap {
  const w = 24;
  const h = 16;
  const config: MapConfig = {
    widthTiles: w,
    heightTiles: h,
    tileSizeFt: 4,
    biome: BiomeType.DUNGEON,
    seed: 1,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 2,
    floorDensity: 0.5,
  };
  const tileMap = new TileMap(w, h);
  tileMap.fill(TilePresets.FLOOR);
  for (let x = 0; x < w; x += 1) {
    tileMap.flags[x] = TilePresets.WALL;
    tileMap.flags[(h - 1) * w + x] = TilePresets.WALL;
  }
  for (let y = 0; y < h; y += 1) {
    tileMap.flags[y * w] = TilePresets.WALL;
    tileMap.flags[y * w + (w - 1)] = TilePresets.WALL;
  }
  // Wall between the two rooms at x=11, y in 2..13, with one door at (11,7).
  for (let y = 2; y < h - 2; y += 1) {
    tileMap.flags[y * w + 11] = TilePresets.WALL;
  }
  tileMap.flags[7 * w + 11] = TilePresets.DOOR_CLOSED;

  const graph = new RoomGraph();
  // Room A: tiles (2,2)–(10,13)  (interior of the left half)
  graph.add(
    { x: 2, y: 2, width: 9, height: 12 },
    [{ x: 11, y: 7, connectsTo: 1 }],
    [],
    RoomRole.NORMAL,
  );
  // Room B: tiles (12,2)–(21,13) (interior of the right half)
  graph.add(
    { x: 12, y: 2, width: 10, height: 12 },
    [{ x: 11, y: 7, connectsTo: 0 }],
    [],
    RoomRole.NORMAL,
  );
  return new FloorMap(config, tileMap, graph, new Uint8Array(w * h), { x: 4, y: 4 });
}

function makeSpawner(
  world: ReturnType<typeof createTestWorld>,
  x: number,
  y: number,
  arenaRadiusFt: number = RATS_NEST.arenaRadiusFt,
): number {
  return spawnSpawner(world, x, y, RATS_NEST.hp, {
    defIndex: RATS_NEST_INDEX,
    contactDamage: RATS_NEST.contactDamage,
    arenaRadiusFt,
  });
}

/**
 * Flip a spawner into the "locked with a real barrier" state that the
 * detector treats as a genuine lock-in. Sets `arenaState=1`, `arenaKind`
 * (defaulting to open-fence), and populates the world's fence/doors
 * snapshot maps so the detector sees a barrier that actually prevents
 * escape. Tests that want the "state machine locked but no barrier" edge
 * case set arenaState directly and skip this helper.
 */
function lockArena(world: ReturnType<typeof createTestWorld>, eid: number, kind: 0 | 1 = 1): void {
  world.stores.spawner.arenaState[eid] = 1;
  world.stores.spawner.arenaKind[eid] = kind;
  if (kind === 1) {
    world.spawnerArenaFence.set(eid, [{ tileIdx: 0, originalFlags: 0 }]);
  } else {
    world.spawnerArenaDoors.set(eid, [0]);
  }
}

/**
 * Minimal Floor-1 objective scaffolding just for the boss-room test.
 * We only populate `bossBattles` because that's the only field
 * `detectArenaLockin` reads.
 */
function attachFloor1WithBoss(
  world: ReturnType<typeof createTestWorld>,
  bossEid: number,
  started: boolean = true,
): void {
  const objective = {
    bossBattles: new Map([
      [
        'slime-rat',
        {
          started,
          bossEid,
          defeated: false,
          displayName: 'Slime Rat',
        },
      ],
    ]),
  };
  // We only need the objective sub-tree; cast through unknown so the test
  // fixture stays terse instead of building a fully valid FloorScenarioState.
  world.floorScenario = { objective } as unknown as FloorScenarioState;
}

// ---------------------------------------------------------------------------
// Spawner lock-in
// ---------------------------------------------------------------------------

describe('detectArenaLockin — spawner arena', () => {
  it('returns null when no spawner exists', () => {
    const world = createTestWorld();
    spawnPlayer(world, 20, 20);
    expect(detectArenaLockin(world, 20, 20)).toBeNull();
  });

  it('returns null when the spawner is idle even if the player is on top of it', () => {
    const world = createTestWorld();
    const spawnerEid = makeSpawner(world, 100, 100);
    // Force arenaState = 0 (idle) — spawnSpawner default.
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(0);
    expect(detectArenaLockin(world, 100, 100)).toBeNull();
  });

  it('open-fence: returns the spawner target when the player is inside the radius', () => {
    const world = createTestWorld();
    const spawnerEid = makeSpawner(world, 100, 100, 6);
    lockArena(world, spawnerEid, 1);
    const target = detectArenaLockin(world, 103, 100);
    expect(target).not.toBeNull();
    expect(target!.kind).toBe('spawner');
    expect(target!.eid).toBe(spawnerEid);
    expect(target!.arenaSpawnerEid).toBe(spawnerEid);
    expect(target!.x).toBe(100);
    expect(target!.y).toBe(100);
  });

  it('open-fence: returns null when the player is outside the radius', () => {
    const world = createTestWorld();
    const spawnerEid = makeSpawner(world, 100, 100, 6);
    lockArena(world, spawnerEid, 1);
    // 20 ft away, radius 6 + 0.5 slack — must be null.
    expect(detectArenaLockin(world, 120, 100)).toBeNull();
  });

  it('open-fence: returns null when arenaState is locked but no fence snapshot exists', () => {
    // Regression guard: `spawnerArenaSystem` skips populating the fence
    // snapshot when raiseFence returns an empty ring (e.g. all target tiles
    // were already impassable). In that case the state machine says
    // "locked" but the player is not actually stuck, so the detector must
    // not fire — otherwise the AI commits to a fight it could walk away
    // from.
    const world = createTestWorld();
    const spawnerEid = makeSpawner(world, 100, 100, 6);
    world.stores.spawner.arenaState[spawnerEid] = 1;
    world.stores.spawner.arenaKind[spawnerEid] = 1;
    // Deliberately no fence snapshot on world.spawnerArenaFence.
    expect(detectArenaLockin(world, 103, 100)).toBeNull();
  });

  it('sealed-room: returns spawner target when player is in the same room', () => {
    const world = createTestWorld();
    world.floorMap = makeTwoRoomMap();
    // Room A interior tiles = (3..9, 3..12) — world coords (12..36, 12..48).
    const spawnerEid = makeSpawner(world, 16, 16, 6);
    lockArena(world, spawnerEid, 0);
    // Player elsewhere in Room A, well outside the disc — sealed-room bit
    // must still lock them in.
    const target = detectArenaLockin(world, 32, 32);
    expect(target).not.toBeNull();
    expect(target!.eid).toBe(spawnerEid);
  });

  it('sealed-room: returns null when player is in an adjacent room', () => {
    const world = createTestWorld();
    world.floorMap = makeTwoRoomMap();
    const spawnerEid = makeSpawner(world, 16, 16, 6);
    lockArena(world, spawnerEid, 0);
    // Player in Room B (right side, interior tile x ≥ 13 → world x ≥ 52),
    // spawner in Room A (left side).
    expect(detectArenaLockin(world, 60, 24)).toBeNull();
  });

  it('resolved arena (state === 2) never returns a lock-in', () => {
    const world = createTestWorld();
    const spawnerEid = makeSpawner(world, 100, 100, 6);
    world.stores.spawner.arenaState[spawnerEid] = 2; // resolved
    world.stores.spawner.arenaKind[spawnerEid] = 1;
    // Even with a stale fence snapshot the detector must ignore a
    // RESOLVED state — the barrier is on its way down.
    world.spawnerArenaFence.set(spawnerEid, [{ tileIdx: 0, originalFlags: 0 }]);
    expect(detectArenaLockin(world, 100, 100)).toBeNull();
  });

  it('dead spawner (deathResolved=1) does not trigger lock-in', () => {
    const world = createTestWorld();
    const spawnerEid = makeSpawner(world, 100, 100, 6);
    lockArena(world, spawnerEid, 1);
    world.stores.spawner.deathResolved[spawnerEid] = 1;
    expect(detectArenaLockin(world, 100, 100)).toBeNull();
  });

  it('deterministic tie-break: lowest spawner eid wins when two are locked', () => {
    const world = createTestWorld();
    const firstEid = makeSpawner(world, 100, 100, 8);
    const secondEid = makeSpawner(world, 104, 100, 8);
    lockArena(world, firstEid, 1);
    lockArena(world, secondEid, 1);
    // Player is inside both radii.
    const target = detectArenaLockin(world, 102, 100);
    expect(target).not.toBeNull();
    expect(target!.eid).toBe(Math.min(firstEid, secondEid));
  });
});

// ---------------------------------------------------------------------------
// Boss-room lock-in
// ---------------------------------------------------------------------------

describe('detectArenaLockin — boss room', () => {
  it('returns the boss target when the started boss shares the player room', () => {
    const world = createTestWorld();
    world.floorMap = makeTwoRoomMap();
    const bossEid = spawnEnemy(world, 24, 24, 200);
    attachFloor1WithBoss(world, bossEid, true);
    const target = detectArenaLockin(world, 30, 30);
    expect(target).not.toBeNull();
    expect(target!.kind).toBe('boss');
    expect(target!.eid).toBe(bossEid);
    expect(target!.arenaSpawnerEid).toBe(-1);
  });

  it('returns null when the boss battle has not started yet', () => {
    const world = createTestWorld();
    world.floorMap = makeTwoRoomMap();
    const bossEid = spawnEnemy(world, 24, 24, 200);
    attachFloor1WithBoss(world, bossEid, false);
    expect(detectArenaLockin(world, 30, 30)).toBeNull();
  });

  it('returns null when the player is in a different room than the boss', () => {
    const world = createTestWorld();
    world.floorMap = makeTwoRoomMap();
    const bossEid = spawnEnemy(world, 24, 24, 200);
    attachFloor1WithBoss(world, bossEid, true);
    // Player is in Room B, boss in Room A.
    expect(detectArenaLockin(world, 60, 24)).toBeNull();
  });

  it('returns null when the boss is dead (health.current <= 0)', () => {
    const world = createTestWorld();
    world.floorMap = makeTwoRoomMap();
    const bossEid = spawnEnemy(world, 24, 24, 200);
    world.stores.health.current[bossEid] = 0;
    attachFloor1WithBoss(world, bossEid, true);
    expect(detectArenaLockin(world, 30, 30)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe('detectArenaLockin — precedence', () => {
  it('spawner arena wins over boss room when both hold simultaneously', () => {
    const world = createTestWorld();
    world.floorMap = makeTwoRoomMap();
    // Boss in Room A.
    const bossEid = spawnEnemy(world, 24, 24, 200);
    attachFloor1WithBoss(world, bossEid, true);
    // Spawner in Room A, locked with a real barrier.
    const spawnerEid = makeSpawner(world, 28, 28, 6);
    lockArena(world, spawnerEid, 0);
    // Player in Room A — both should be candidates, spawner must win.
    const target = detectArenaLockin(world, 30, 30);
    expect(target).not.toBeNull();
    expect(target!.kind).toBe('spawner');
    expect(target!.eid).toBe(spawnerEid);
  });
});
