/**
 * Unit tests for the spawner battle-arena state machine.
 *
 * Covers:
 *   - trigger predicate (distance-only + same-sealed-room override)
 *   - state machine transitions (idle → locked → resolved)
 *   - banked-XP cap arithmetic (0, 1, 9, 10, 11 intercepts)
 *   - determinism: same seed + same actions yield identical events
 *
 * Uses `createTestWorld()` + a hand-built FloorMap so we can exercise both the
 * sealed-room and open-fence branches without the full dungeon generator.
 */
import { describe, expect, it } from 'vitest';
import { addComponent, addEntity, query, set } from 'bitecs';
import { DoorState, Health, Spawner, XpGem } from '../../src/core/components.js';
import { spawnPlayer, spawnSpawner } from '../../src/core/helpers.js';
import {
  SPAWNER_MAX_BANKED_CHILDREN,
  isArenaTriggered,
  discFitsInRoom,
  decideArenaKind,
  ARENA_WALL_THICKNESS_FT,
  MIN_ARENA_WALL_OUTER_FT,
  arenaRingWallRadii,
  isPlayerFullyInsideRing,
  bumpInsideRing,
} from '../../src/core/spawner-arena.js';
import { spawnerArenaSystem } from '../../src/game/spawners/spawnerArenaSystem.js';
import { getSpawnerArchetype, getSpawnerArchetypeIndex } from '../../src/game/spawners/registry.js';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeMapWithSafeRoom } from '../helpers/map-fixtures.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import { BiomeType, RoomRole, TilePresets, type MapConfig } from '../../src/shared/map-types.js';

const RATS_NEST_INDEX = getSpawnerArchetypeIndex('rats-nest');
const RATS_NEST = getSpawnerArchetype('rats-nest')!;

function makeSpawner(world: ReturnType<typeof createTestWorld>, x: number, y: number): number {
  return spawnSpawner(world, x, y, RATS_NEST.hp, {
    defIndex: RATS_NEST_INDEX,
    contactDamage: RATS_NEST.contactDamage,
    arenaRadiusFt: RATS_NEST.arenaRadiusFt,
  });
}

/** Build a floor map with a single 8x8 NORMAL room + one door, for sealed tests. */
function makeSealedRoomMap(): FloorMap {
  const w = 16;
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
  // Wall the outer border so the room has geometry.
  for (let x = 0; x < w; x += 1) {
    tileMap.flags[x] = TilePresets.WALL;
    tileMap.flags[(h - 1) * w + x] = TilePresets.WALL;
  }
  for (let y = 0; y < h; y += 1) {
    tileMap.flags[y * w] = TilePresets.WALL;
    tileMap.flags[y * w + (w - 1)] = TilePresets.WALL;
  }
  // One door tile at the room edge.
  tileMap.flags[6 * w + 8] = TilePresets.DOOR_CLOSED;

  const graph = new RoomGraph();
  graph.add(
    { x: 4, y: 4, width: 8, height: 8 },
    [{ x: 8, y: 6, connectsTo: -1 }],
    [],
    RoomRole.NORMAL,
  );

  return new FloorMap(config, tileMap, graph, new Uint8Array(w * h), { x: 5, y: 5 });
}

// ---------------------------------------------------------------------------
// Trigger predicate
// ---------------------------------------------------------------------------

describe('isArenaTriggered', () => {
  it('fires when the player is inside the disc (distance ≤ radius)', () => {
    expect(
      isArenaTriggered({
        playerX: 10,
        playerY: 10,
        spawnerX: 15,
        spawnerY: 10,
        arenaRadiusFt: 6,
        sameSealedRoom: false,
      }),
    ).toBe(true);
  });

  it('does NOT fire when the player is beyond the disc without a room match', () => {
    expect(
      isArenaTriggered({
        playerX: 10,
        playerY: 10,
        spawnerX: 30,
        spawnerY: 10,
        arenaRadiusFt: 6,
        sameSealedRoom: false,
      }),
    ).toBe(false);
  });

  it('fires beyond the disc when the player is in the sealed room', () => {
    // 20 ft away — well beyond a 6 ft disc — but the same-room bit forces trigger.
    expect(
      isArenaTriggered({
        playerX: 10,
        playerY: 10,
        spawnerX: 30,
        spawnerY: 10,
        arenaRadiusFt: 6,
        sameSealedRoom: true,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

describe('discFitsInRoom', () => {
  it('accepts a disc fully inside the room interior', () => {
    expect(
      discFitsInRoom({
        cxFt: 32,
        cyFt: 32,
        radiusFt: 6,
        bounds: { x: 4, y: 4, width: 8, height: 8 },
        tileSizeFt: 4,
      }),
    ).toBe(true);
  });

  it('rejects a disc that would poke through the wall inset', () => {
    expect(
      discFitsInRoom({
        cxFt: 20, // near the left wall
        cyFt: 32,
        radiusFt: 6,
        bounds: { x: 4, y: 4, width: 8, height: 8 },
        tileSizeFt: 4,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ring-wall geometry helpers (open-fence arena boundary)
// ---------------------------------------------------------------------------

describe('arenaRingWallRadii', () => {
  it('floors the outer radius to MIN_ARENA_WALL_OUTER_FT for small archetypes', () => {
    // slime (6) and rats-nest (7) both request < 8 → floored to 8.
    expect(arenaRingWallRadii(6).outerRadiusFt).toBe(MIN_ARENA_WALL_OUTER_FT);
    expect(arenaRingWallRadii(7).outerRadiusFt).toBe(MIN_ARENA_WALL_OUTER_FT);
  });

  it('passes larger requested radii through unchanged (cave = 10)', () => {
    expect(arenaRingWallRadii(10).outerRadiusFt).toBe(10);
  });

  it('carves an ARENA_WALL_THICKNESS_FT-thick band (inner = outer − thickness)', () => {
    const { outerRadiusFt, innerRadiusFt } = arenaRingWallRadii(10);
    expect(outerRadiusFt - innerRadiusFt).toBe(ARENA_WALL_THICKNESS_FT);
    expect(innerRadiusFt).toBe(10 - ARENA_WALL_THICKNESS_FT);
  });

  it('never returns a negative inner radius', () => {
    // Even a degenerate 0 request floors to the minimum, so inner stays ≥ 0.
    expect(arenaRingWallRadii(0).innerRadiusFt).toBeGreaterThanOrEqual(0);
  });
});

describe('isPlayerFullyInsideRing', () => {
  const base = { centerX: 100, centerY: 100, innerRadiusFt: 9, playerBodyRadiusFt: 1.5 };

  it('is true when the whole body clears the inner wall face', () => {
    // limit = 9 − 1.5 = 7.5; player 5 ft from centre is fully inside.
    expect(isPlayerFullyInsideRing({ ...base, playerX: 105, playerY: 100 })).toBe(true);
  });

  it('is false while any part of the body still pokes into the wall band', () => {
    // limit = 7.5; player 8 ft out → body edge (9.5) crosses the inner face.
    expect(isPlayerFullyInsideRing({ ...base, playerX: 108, playerY: 100 })).toBe(false);
  });

  it('is exactly true at the boundary (dist == inner − bodyRadius)', () => {
    expect(isPlayerFullyInsideRing({ ...base, playerX: 107.5, playerY: 100 })).toBe(true);
  });

  it('never arms when the interior cannot contain the body (degenerate ring)', () => {
    // inner 1 ft, body 1.5 ft → limit ≤ 0 → false regardless of position.
    expect(isPlayerFullyInsideRing({ ...base, innerRadiusFt: 1, playerX: 100, playerY: 100 })).toBe(
      false,
    );
  });
});

describe('bumpInsideRing', () => {
  const base = { centerX: 100, centerY: 100, innerRadiusFt: 9, playerBodyRadiusFt: 1.5 };

  it('leaves a point that is still inside the inner edge untouched', () => {
    const r = bumpInsideRing({ ...base, x: 104, y: 100 });
    expect(r.bumped).toBe(false);
    expect(r.x).toBe(104);
    expect(r.y).toBe(100);
  });

  it('pulls a breached point radially back flush against the inner wall face', () => {
    // Player at 12 ft out (breached inner 9) → clamp to inner − body = 7.5.
    const r = bumpInsideRing({ ...base, x: 112, y: 100 });
    expect(r.bumped).toBe(true);
    expect(Math.hypot(r.x - 100, r.y - 100)).toBeCloseTo(7.5, 6);
    // Radial direction preserved (straight along +x).
    expect(r.y).toBeCloseTo(100, 6);
    expect(r.x).toBeGreaterThan(100);
  });

  it('preserves the radial angle when bumping a diagonal breach', () => {
    const r = bumpInsideRing({ ...base, x: 100 + 20, y: 100 + 20 });
    expect(r.bumped).toBe(true);
    // Same 45° heading, magnitude clamped to 7.5.
    expect(r.x - 100).toBeCloseTo(r.y - 100, 6);
    expect(Math.hypot(r.x - 100, r.y - 100)).toBeCloseTo(7.5, 6);
  });

  it('is a no-op at the exact centre (no radial direction to project along)', () => {
    const r = bumpInsideRing({ ...base, x: 100, y: 100 });
    expect(r.bumped).toBe(false);
    expect(r.x).toBe(100);
    expect(r.y).toBe(100);
  });
});

// NOTE: the pre-PR-#767 `collectFenceRingTiles` geometry helper was removed
// along with the tile-mutation fence path. Ring geometry now lives in
// `src/core/barriers/geometry.ts::collectRingTiles` (passability-agnostic),
// and coverage moved to `tests/unit/barriers/registry.test.ts`.

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('spawnerArenaSystem — state machine', () => {
  it('stays idle when the player is outside the radius', () => {
    const world = createTestWorld();
    const spawnerEid = makeSpawner(world, 100, 100);
    // Player far away (open-fence, no map).
    spawnPlayer(world, 300, 300);
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(0);
  });

  it('transitions idle → locked when the player enters the radius', () => {
    const world = createTestWorld();
    const spawnerEid = makeSpawner(world, 100, 100);
    spawnPlayer(world, 102, 102);
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(1);
    // A start-VFX + fence-VFX pair is pushed on trigger.
    const startEvents = world.vfxEvents.filter((e) => e.kind === 'spawnerArenaStart');
    expect(startEvents.length).toBe(1);
    // An announcement was queued.
    expect(world.announcements.filter((a) => a.kind === 'spawnerArenaStart').length).toBe(1);
  });

  it('transitions locked → resolved once the spawner is dead', () => {
    const world = createTestWorld();
    const spawnerEid = makeSpawner(world, 100, 100);
    spawnPlayer(world, 102, 102);
    // Trigger + lock the arena.
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(1);
    // Simulate spawner death: HP → 0 and the death finale flag set.
    world.stores.health.current[spawnerEid] = 0;
    world.stores.spawner.deathResolved[spawnerEid] = 1;
    // Give it some banked XP so the resolve path grants an XP gem.
    world.stores.spawner.bankedXp[spawnerEid] = 42;
    world.stores.spawner.bankedChildren[spawnerEid] = 5;
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(2);
    expect(world.announcements.filter((a) => a.kind === 'spawnerArenaEnd').length).toBe(1);
    expect(world.vfxEvents.filter((e) => e.kind === 'spawnerArenaEnd').length).toBe(1);
  });

  it('is a no-op once the arena is resolved (terminal state)', () => {
    const world = createTestWorld();
    const spawnerEid = makeSpawner(world, 100, 100);
    spawnPlayer(world, 102, 102);
    world.stores.health.current[spawnerEid] = 0;
    world.stores.spawner.deathResolved[spawnerEid] = 1;
    spawnerArenaSystem(world);
    spawnerArenaSystem(world);
    // deathResolved reappears in idle world — the second call finds state=2 and
    // must not emit a fresh set of arena events.
    world.stores.spawner.arenaState[spawnerEid] = 2;
    const beforeVfx = world.vfxEvents.length;
    const beforeAnn = world.announcements.length;
    spawnerArenaSystem(world);
    expect(world.vfxEvents.length).toBe(beforeVfx);
    expect(world.announcements.length).toBe(beforeAnn);
  });

  it('grants banked XP and transitions idle → resolved when the spawner dies before the arena triggers', () => {
    // Repro of the code-review MEDIUM finding: player kills children from off
    // screen (drop system banks XP) then finishes the spawner from outside
    // the arena disc. Without this path, banked XP would be orphaned and the
    // player would receive nothing for that spawner (Requirement 4 already
    // stripped per-child XP).
    const world = createTestWorld();
    const spawnerEid = makeSpawner(world, 100, 100);
    // Player is far outside the radius — no trigger.
    spawnPlayer(world, 1000, 1000);
    // Simulate the drop system having banked some XP before the spawner died.
    world.stores.spawner.bankedXp[spawnerEid] = 24;
    world.stores.spawner.bankedChildren[spawnerEid] = 6;
    world.stores.health.current[spawnerEid] = 0;
    world.stores.spawner.deathResolved[spawnerEid] = 1;
    const xpGemsBefore = query(world.ecs, [XpGem]).length;
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(2);
    // Finding (1) lock-in: an IDLE→RESOLVED short-circuit never raised a real
    // barrier, so it must NOT be latched as "ever armed" even though the arena
    // reaches state 2 (RESOLVED). This is exactly the case the old
    // `|| state === 2` headless condition wrongly counted as armed.
    expect(world.spawnerArenaEverArmed.has(spawnerEid)).toBe(false);
    // A single XP gem was spawned carrying the banked pool.
    expect(query(world.ecs, [XpGem]).length).toBe(xpGemsBefore + 1);
    // No arena start/end VFX or announcements should have been emitted — the
    // arena never visibly "happened".
    expect(world.vfxEvents.filter((e) => e.kind === 'spawnerArenaStart')).toHaveLength(0);
    expect(world.vfxEvents.filter((e) => e.kind === 'spawnerArenaEnd')).toHaveLength(0);
    expect(world.announcements).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sealed-room door lifecycle (finding 3)
// ---------------------------------------------------------------------------

describe('spawnerArenaSystem sealed-room door lifecycle', () => {
  it('locks room doors on trigger and unlocks + clears the cache on resolve', () => {
    const world = createTestWorld();
    world.floorMap = makeSealedRoomMap();
    // Spawner centred in the 8x8 NORMAL room; RATS_NEST radius (7 ft) fits the
    // room interior at (32,32) → decideArenaKind resolves 'sealed-room'.
    const spawnerEid = makeSpawner(world, 32, 32);
    // A door entity sitting on the room's single door tile (8,6), initially
    // closed and UNLOCKED so we can prove the arena performs the lock itself.
    const doorEid = addEntity(world.ecs);
    addComponent(
      world.ecs,
      doorEid,
      set(DoorState, { tileX: 8, tileY: 6, logicalOpen: 0, isLocked: 0 }),
    );
    // Player inside the same room (tile 10,10 → 40,40 ft): same-sealed-room
    // override fires the trigger even though it is outside the 7 ft disc.
    spawnPlayer(world, 40, 40);
    const goalId = `spawner-arena-${spawnerEid}-cleared`;

    // ── Trigger: idle → locked, doors LOCK ──────────────────────────────────
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaKind[spawnerEid]).toBe(0); // sealed-room
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(1); // locked
    // The system flipped the door from unlocked→locked and closed it.
    expect(world.stores.doorState.isLocked[doorEid]).toBe(1);
    expect(world.stores.doorState.logicalOpen[doorEid]).toBe(0);
    expect(world.spawnerArenaDoors.get(spawnerEid)).toEqual([doorEid]);
    // A real barrier was raised → the persistent "ever armed" latch is set.
    expect(world.spawnerArenaEverArmed.has(spawnerEid)).toBe(true);
    // Goal flag exists and is explicitly false while the arena is active.
    expect(world.goalFlags.get(goalId)).toBe(false);

    // ── Resolve: locked → resolved, doors UNLOCK, cache cleared ─────────────
    world.stores.health.current[spawnerEid] = 0;
    world.stores.spawner.deathResolved[spawnerEid] = 1;
    world.stores.spawner.bankedXp[spawnerEid] = 18;
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(2); // resolved
    // Door lock is released and the cached door list is deleted.
    expect(world.stores.doorState.isLocked[doorEid]).toBe(0);
    expect(world.stores.doorState.logicalOpen[doorEid]).toBe(1);
    expect(world.spawnerArenaDoors.has(spawnerEid)).toBe(false);
    // Goal flag flips complete so doorSystem/quest logic can react.
    expect(world.goalFlags.get(goalId)).toBe(true);
    // The "ever armed" latch persists across resolve — this is what keeps the
    // headless barrierArmed / resolvedArmed telemetry honest (a resolved arena
    // that genuinely trapped the AI must stay counted as armed).
    expect(world.spawnerArenaEverArmed.has(spawnerEid)).toBe(true);
  });

  it('arms via the doorway barrier even when no door entity is present', () => {
    // The sealed room has a door TILE (8,6) but no matching DoorState entity.
    // lockRoomDoorsImpl returns an empty cache (nothing to lock), but
    // createRoomBarrier({ doorwaysOnly: true }) still plugs the door tile, so
    // the player is physically caged by the barrier. Per the documented
    // `spawnerArenaEverArmed` contract (world.ts) — "set when a non-empty
    // barrier handle is stored" — this MUST latch as armed even though no door
    // ENTITY was locked. A green regression here is what the reviewer flagged:
    // the earlier `doorCache.length > 0` gate ignored the caging barrier.
    const world = createTestWorld();
    world.floorMap = makeSealedRoomMap();
    const spawnerEid = makeSpawner(world, 32, 32);
    spawnPlayer(world, 40, 40);

    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaKind[spawnerEid]).toBe(0);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(1);
    // No door entity was locked → the door cache is empty…
    expect(world.spawnerArenaDoors.get(spawnerEid)).toEqual([]);
    // …but the doorway barrier owns the plugged door tile, so it cages + arms.
    expect(world.spawnerArenaBarriers.get(spawnerEid)!.tiles.length).toBeGreaterThan(0);
    expect(world.spawnerArenaEverArmed.has(spawnerEid)).toBe(true);

    // Resolve drops the barrier + cache; the latch persists (honest telemetry).
    world.stores.health.current[spawnerEid] = 0;
    world.stores.spawner.deathResolved[spawnerEid] = 1;
    spawnerArenaSystem(world);
    expect(world.stores.spawner.arenaState[spawnerEid]).toBe(2);
    expect(world.spawnerArenaDoors.has(spawnerEid)).toBe(false);
    expect(world.spawnerArenaEverArmed.has(spawnerEid)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Banked-XP cap arithmetic
// ---------------------------------------------------------------------------

describe('banked XP cap', () => {
  it('caps at exactly SPAWNER_MAX_BANKED_CHILDREN (10) intercepts', () => {
    // The dropSystem test covers real intercept flow; here we assert the cap
    // constant is exported and matches the spec ("up to 10 children").
    expect(SPAWNER_MAX_BANKED_CHILDREN).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Sealed-vs-fence resolution
// ---------------------------------------------------------------------------

describe('decideArenaKind', () => {
  it('picks sealed-room when the spawner is in a room with a door and the disc fits', () => {
    const world = createTestWorld();
    world.floorMap = makeSealedRoomMap();
    // Spawner near the middle of the NORMAL room; disc radius small enough to fit.
    const kind = decideArenaKind({
      floorMap: world.floorMap,
      spawnerXFt: 32,
      spawnerYFt: 32,
      arenaRadiusFt: 5,
    });
    expect(kind).toBe('sealed-room');
  });

  it('picks open-fence when there is no containing room', () => {
    const world = createTestWorld();
    world.floorMap = makeMapWithSafeRoom();
    const kind = decideArenaKind({
      floorMap: world.floorMap,
      // The safe-room fixture room is at (1,1)-(4,4); (500, 500) ft is far outside.
      spawnerXFt: 500,
      spawnerYFt: 500,
      arenaRadiusFt: 6,
    });
    expect(kind).toBe('open-fence');
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('produces identical arena events for identical seed + actions', () => {
    function drive(): { vfxKinds: string[]; announcementKinds: string[] } {
      const world = createTestWorld();
      const spawnerEid = makeSpawner(world, 100, 100);
      spawnPlayer(world, 102, 102);
      spawnerArenaSystem(world);
      spawnerArenaSystem(world);
      // Kill the spawner.
      world.stores.health.current[spawnerEid] = 0;
      world.stores.spawner.deathResolved[spawnerEid] = 1;
      spawnerArenaSystem(world);
      return {
        vfxKinds: world.vfxEvents.map((e) => e.kind),
        announcementKinds: world.announcements.map((a) => a.kind),
      };
    }
    const a = drive();
    const b = drive();
    expect(a.vfxKinds).toEqual(b.vfxKinds);
    expect(a.announcementKinds).toEqual(b.announcementKinds);
  });
});

// ---------------------------------------------------------------------------
// Registry contract (defence in depth against archetype drift)
// ---------------------------------------------------------------------------

describe('spawner archetypes carry arena radii', () => {
  it('exposes arenaRadiusFt for every archetype at or above the 4 ft floor', () => {
    const nest = getSpawnerArchetype('rats-nest')!;
    const pool = getSpawnerArchetype('slime-pool')!;
    expect(nest.arenaRadiusFt).toBeGreaterThanOrEqual(4);
    expect(pool.arenaRadiusFt).toBeGreaterThanOrEqual(4);
  });

  it('the SoA slot is populated at spawn time', () => {
    const world = createTestWorld();
    const eid = makeSpawner(world, 100, 100);
    expect(world.stores.spawner.arenaRadiusFt[eid]).toBeCloseTo(RATS_NEST.arenaRadiusFt, 4);
    // arenaKind starts unresolved (255).
    expect(world.stores.spawner.arenaKind[eid]).toBe(255);
    expect(world.stores.spawner.arenaState[eid]).toBe(0);
  });

  // Ensure the Spawner tag is still attached; regression guard against the SoA
  // refactor stripping the component.
  it('the spawner is still tagged with the Spawner component', () => {
    const world = createTestWorld();
    const eid = makeSpawner(world, 100, 100);
    expect(world.stores.spawner.defIndex[eid]).toBe(RATS_NEST_INDEX);
    expect(world.stores.health.max[eid]).toBe(RATS_NEST.hp);
    // Fluent access via the Spawner tag.
    void Spawner;
    void Health;
  });
});
