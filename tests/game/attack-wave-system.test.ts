/**
 * Attack wave system tests (Issue #3639).
 *
 * Coverage:
 * 1. Flag off ⇒ zero spawns + zero RNG draws
 * 2. Flag on ⇒ wave fires at intervalMs with exactly packSize rats
 * 3. Suppression when pathable distance to nearest safe room ≤ threshold
 * 4. Not suppressed when euclidean-near but path-far (key correctness test)
 * 5. All spawn points ≥ off-screen radius from player
 * 6. Determinism: same seed ⇒ identical positions/timing
 * 7. maxAliveFromWaves cap respected (including dynamic recount after deaths)
 * 8. System is wired in floor-main-scene-options (adjacency + presence)
 */

import { describe, expect, it, vi } from 'vitest';
import { hasComponent, query } from 'bitecs';
import { createTestWorld } from '../helpers/world-factory.js';
import { makeMapWithSafeRoom, makePathMap } from '../helpers/map-fixtures.js';
import { spawnPlayer } from '../../src/core/spawners/combatants.js';
import { attackWaveSystem } from '../../src/game/attack-wave-system.js';
import { AttackWaveRat, Damage, DeathTimer, Enemy } from '../../src/core/components.js';
import { RoomRole, TilePresets, BiomeType, type MapConfig } from '../../src/shared/map-types.js';
import { FloorMap } from '../../src/core/map/FloorMap.js';
import { RoomGraph } from '../../src/core/map/RoomGraph.js';
import { TileMap } from '../../src/core/map/TileMap.js';
import {
  attachBarriersToFloorMap,
  createRingBarrier,
  createRingWallBarrier,
  dropBarrier,
} from '../../src/core/barriers/index.js';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { spawnerArenaSystem, spawnerSystem } from '../../src/game/index.js';
import { enemyAISystem } from '../../src/game/enemyAISystem.js';
import { movementSystem } from '../../src/core/systems/movementSystem.js';
import { dropSystem } from '../../src/core/systems/dropSystem.js';
import { GAME } from '../../src/shared/constants.js';
import { pxToFt } from '../../src/shared/units.js';
import { floor1Config } from '../../src/shared/floor-config.js';
import tuning from '../../src/shared/data/tuning.json';
import { getRatTemplate } from '../../src/game/spawners/template-accessor.js';
import { getBodyRadius } from '../../src/core/physics-body.js';
import { getWorldFloorBehavior } from '../../src/core/floor-behavior.js';

type TuningSchema = typeof tuning & {
  attackWaves: {
    intervalMs: number;
    packSize: number;
    spawnRingRadiusFt: number;
    safeRoomSuppressionTiles: number;
    maxAliveFromWaves: number;
  };
};
const TUNING = tuning as TuningSchema;

/** Count rats spawned (Enemy-tagged entities, excluding the player). */
function enemyCount(world: ReturnType<typeof createTestWorld>): number {
  return query(world.ecs, [Enemy]).length;
}

describe('attackWaveSystem', () => {
  describe('flag off', () => {
    it('produces zero spawns and consumes zero RNG draws', () => {
      const world = createTestWorld();
      world.floorId = 'floor1';
      world.floorMap = makeMapWithSafeRoom();
      spawnPlayer(world, 400, 400);
      world.attackWaveFlags.attackWaves = false;

      const rngSpy = vi.spyOn(world.rng, 'next');
      const nextIntSpy = vi.spyOn(world.rng, 'nextInt');

      // Advance well past the interval and run the system repeatedly.
      for (let i = 0; i < 10; i += 1) {
        world.elapsedMs += TUNING.attackWaves.intervalMs;
        attackWaveSystem(world);
      }

      expect(rngSpy).not.toHaveBeenCalled();
      expect(nextIntSpy).not.toHaveBeenCalled();
      expect(enemyCount(world)).toBe(0);
      expect(world.attackWaveState).toBeUndefined();
    });
  });

  describe('flag on', () => {
    it('fires a wave at intervalMs with exactly packSize rats, then again at the next interval', () => {
      const world = createTestWorld();
      world.floorId = 'floor1';
      world.floorMap = makeMapWithSafeRoom({ widthTiles: 80, heightTiles: 80 });
      spawnPlayer(world, 400, 400);
      world.attackWaveFlags.attackWaves = true;

      // Before the first interval elapses: no spawn.
      world.elapsedMs = TUNING.attackWaves.intervalMs - 1;
      attackWaveSystem(world);
      expect(enemyCount(world)).toBe(0);

      // At the interval boundary: exactly packSize rats spawn.
      world.elapsedMs = TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);
      expect(enemyCount(world)).toBe(TUNING.attackWaves.packSize);

      // No new wave until the next interval elapses.
      world.elapsedMs += TUNING.attackWaves.intervalMs - 1;
      attackWaveSystem(world);
      expect(enemyCount(world)).toBe(TUNING.attackWaves.packSize);

      // Second wave at the next interval boundary.
      world.elapsedMs += 1;
      attackWaveSystem(world);
      expect(enemyCount(world)).toBe(TUNING.attackWaves.packSize * 2);
    });

    // The gate is the floor manifest's `trashAttackWaves` behavior flag, not a
    // hardcoded floor id: every floor that does not declare it stays inert, and
    // a new floor opts in through its manifest instead of a code edit here.
    it.each(['floor2', 'floor3', 'floor4'])(
      'is inert on %s, which does not declare trashAttackWaves, even when enabled',
      (floorId) => {
        const world = createTestWorld();
        world.floorId = floorId;
        world.floorMap = makeMapWithSafeRoom({ widthTiles: 80, heightTiles: 80 });
        spawnPlayer(world, 400, 400);
        world.attackWaveFlags.attackWaves = true;
        world.elapsedMs = TUNING.attackWaves.intervalMs;

        expect(getWorldFloorBehavior(world).trashAttackWaves).toBe(false);

        attackWaveSystem(world);

        expect(enemyCount(world)).toBe(0);
        expect(world.attackWaveState).toBeUndefined();
      },
    );

    it('is inert on an unregistered floor id, which has no manifest at all', () => {
      const world = createTestWorld();
      world.floorId = 'floor-does-not-exist';
      world.floorMap = makeMapWithSafeRoom({ widthTiles: 80, heightTiles: 80 });
      spawnPlayer(world, 400, 400);
      world.attackWaveFlags.attackWaves = true;
      world.elapsedMs = TUNING.attackWaves.intervalMs;

      attackWaveSystem(world);

      expect(enemyCount(world)).toBe(0);
      expect(world.attackWaveState).toBeUndefined();
    });

    it('is inert on a synthetic world with no floor assigned, even when enabled', () => {
      // `getWorldFloorBehavior` falls back to `floor${world.floor}` and
      // `world.floor` defaults to 1, so without an explicit `floorId` guard a
      // floor-less world would inherit Floor 1's manifest and spawn waves.
      const world = createTestWorld();
      world.floorMap = makeMapWithSafeRoom({ widthTiles: 80, heightTiles: 80 });
      spawnPlayer(world, 400, 400);
      world.attackWaveFlags.attackWaves = true;
      world.elapsedMs = TUNING.attackWaves.intervalMs;

      expect(world.floorId).toBe('');
      expect(getWorldFloorBehavior(world).trashAttackWaves).toBe(true);

      attackWaveSystem(world);

      expect(enemyCount(world)).toBe(0);
      expect(world.attackWaveState).toBeUndefined();
    });

    it('spawns rats with always-aggro CHASE behavior so they close distance on the player', () => {
      const world = createTestWorld();
      world.floorId = 'floor1';
      world.floorMap = makeMapWithSafeRoom({ widthTiles: 80, heightTiles: 80 });
      const playerEid = spawnPlayer(world, 400, 400);
      world.attackWaveFlags.attackWaves = true;

      world.elapsedMs = TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);

      const rats = query(world.ecs, [Enemy]);
      expect(rats.length).toBeGreaterThan(0);
      const ratTemplate = getRatTemplate();

      for (const eid of rats) {
        expect(world.stores.enemyBehavior.aggroRange[eid]).toBe(0);
        expect(world.stores.sprite.textureId[eid]).toBe(ratTemplate.textureId);
        expect(getBodyRadius(world, eid)).toBe(
          Math.max(ratTemplate.spriteWidth, ratTemplate.spriteHeight) * 0.5,
        );
        expect(world.enemyAppearanceKeys.get(eid)).toBe(ratTemplate.id);
        expect(hasComponent(world.ecs, eid, AttackWaveRat)).toBe(true);
        expect(hasComponent(world.ecs, eid, Damage)).toBe(ratTemplate.contactDamage > 0);
        if (ratTemplate.contactDamage > 0) {
          expect(world.stores.damage.amount[eid]).toBe(ratTemplate.contactDamage);
        }
      }

      // Force aggro to be active immediately (past any stagger delay) and
      // confirm the rat actually closes distance toward the player.
      const rat = rats[0]!;
      world.stores.enemyBehavior.aggroEnableAtMs[rat] = 0;
      const startDist = Math.hypot(
        world.stores.position.x[rat]! - world.stores.position.x[playerEid]!,
        world.stores.position.y[rat]! - world.stores.position.y[playerEid]!,
      );
      expect(startDist).toBeGreaterThan(0);

      for (let frame = 0; frame < 30; frame += 1) {
        world.frameCount += 1;
        world.elapsedMs += 16;
        enemyAISystem(world);
        movementSystem(world);
      }

      const endDist = Math.hypot(
        world.stores.position.x[rat]! - world.stores.position.x[playerEid]!,
        world.stores.position.y[rat]! - world.stores.position.y[playerEid]!,
      );
      expect(endDist).toBeLessThan(startDist);
    });
  });

  describe('safe-room suppression (pathable distance)', () => {
    function makeCorridorMap(): FloorMap {
      // 20x20 open room; a safe room sits at the far top-left corner.
      const w = 20;
      const h = 20;
      const config: MapConfig = {
        widthTiles: w,
        heightTiles: h,
        tileSizeFt: 4,
        biome: BiomeType.DUNGEON,
        seed: 1,
        roomWidthRange: [4, 8],
        roomHeightRange: [4, 8],
        maxRooms: 2,
        floorDensity: 1,
      };
      const tileMap = new TileMap(w, h);
      tileMap.fill(TilePresets.FLOOR);

      const graph = new RoomGraph();
      graph.add({ x: 1, y: 1, width: 3, height: 3 }, [], [], RoomRole.SAFE);

      return new FloorMap(config, tileMap, graph, new Uint8Array(w * h), { x: 10, y: 10 });
    }

    it('suppresses waves when pathable distance to nearest safe room is within threshold', () => {
      const world = createTestWorld();
      world.floorId = 'floor1';
      world.floorMap = makeCorridorMap();
      // Safe room center is around tile (2,2); pick a nearby open player tile.
      spawnPlayer(world, 3 * 4 + 2, 2 * 4 + 2); // tile (3,2), tileSizeFt=4
      world.attackWaveFlags.attackWaves = true;
      TUNING.attackWaves.safeRoomSuppressionTiles = 10;

      world.elapsedMs = TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);

      expect(enemyCount(world)).toBe(0);
    });

    it('does not suppress when the player is far (pathable) from any safe room', () => {
      const world = createTestWorld();
      world.floorId = 'floor1';
      world.floorMap = makeCorridorMap();
      // Far corner from the safe room at (1,1)-(4,4).
      spawnPlayer(world, 18 * 4 + 2, 18 * 4 + 2);
      world.attackWaveFlags.attackWaves = true;
      TUNING.attackWaves.safeRoomSuppressionTiles = 5;

      world.elapsedMs = TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);

      expect(enemyCount(world)).toBeGreaterThan(0);
    });

    it('does not spawn while the player is inside a safe space, regardless of distance field', () => {
      const world = createTestWorld();
      world.floorId = 'floor1';
      world.floorMap = makeCorridorMap();
      spawnPlayer(world, 18 * 4 + 2, 18 * 4 + 2);
      world.attackWaveFlags.attackWaves = true;
      world.playerInSafeRoom = true;

      world.elapsedMs = TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);

      expect(enemyCount(world)).toBe(0);
    });

    it('is NOT suppressed when euclidean-near but path-far from a safe room (walled detour)', () => {
      // Build an L-shaped corridor: a wall blocks the direct line between the
      // player and the safe room, forcing a long detour even though the
      // straight-line distance is short.
      const w = 20;
      const h = 20;
      const config: MapConfig = {
        widthTiles: w,
        heightTiles: h,
        tileSizeFt: 4,
        biome: BiomeType.DUNGEON,
        seed: 1,
        roomWidthRange: [4, 8],
        roomHeightRange: [4, 8],
        maxRooms: 2,
        floorDensity: 1,
      };
      const tileMap = new TileMap(w, h);
      tileMap.fill(TilePresets.FLOOR);

      // Solid wall spanning most of the map at y=10, with a gap only at the
      // far right (x=18), forcing any path from the bottom half to the top
      // half through that single gap.
      for (let x = 0; x < w; x += 1) {
        if (x !== 18) {
          tileMap.setFlags(x, 10, TilePresets.WALL);
        }
      }

      const graph = new RoomGraph();
      // Safe room just above the wall, close in a straight line to the player
      // below the wall, but the only path is the long way around.
      graph.add({ x: 1, y: 8, width: 3, height: 2 }, [], [], RoomRole.SAFE);

      const floorMap = new FloorMap(config, tileMap, graph, new Uint8Array(w * h), {
        x: 10,
        y: 10,
      });

      const world = createTestWorld();
      world.floorId = 'floor1';
      world.floorMap = floorMap;
      // Player just below the wall, euclidean-close to the safe room above it.
      spawnPlayer(world, 2 * 4 + 2, 11 * 4 + 2);
      world.attackWaveFlags.attackWaves = true;
      TUNING.attackWaves.safeRoomSuppressionTiles = 5;

      const euclideanTiles = Math.hypot(2 - 2, 11 - 9); // ~2 tiles straight-line
      expect(euclideanTiles).toBeLessThanOrEqual(TUNING.attackWaves.safeRoomSuppressionTiles);

      world.elapsedMs = TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);

      // Pathable distance goes all the way around through x=18 — far greater
      // than the suppression threshold — so the wave must NOT be suppressed.
      expect(enemyCount(world)).toBeGreaterThan(0);
    });

    it('suppresses through a closed but auto-openable door (door-aware pathing)', () => {
      const world = createTestWorld();
      world.floorId = 'floor1';
      const floorMap = makePathMap(false, { tileSizeFt: 4 });
      floorMap.roomGraph.add({ x: 2, y: 3, width: 2, height: 2 }, [], [], RoomRole.SAFE);
      world.floorMap = floorMap;
      // Place the player on the opposite side of the door wall.
      spawnPlayer(world, 9 * 4 + 2, 4 * 4 + 2);
      world.attackWaveFlags.attackWaves = true;
      const originalThreshold = TUNING.attackWaves.safeRoomSuppressionTiles;
      TUNING.attackWaves.safeRoomSuppressionTiles = 32;
      try {
        world.elapsedMs = TUNING.attackWaves.intervalMs;
        attackWaveSystem(world);
        expect(enemyCount(world)).toBe(0);
      } finally {
        TUNING.attackWaves.safeRoomSuppressionTiles = originalThreshold;
      }
    });

    it('reuses the cached field and invalidates it for map, cleared-room ownership, and barrier changes', () => {
      const world = createTestWorld();
      world.floorId = 'floor1';
      const firstMap = makeMapWithSafeRoom({ widthTiles: 80, heightTiles: 80 });
      world.floorMap = firstMap;
      attachBarriersToFloorMap(world);
      spawnPlayer(world, 400, 400);
      world.attackWaveFlags.attackWaves = true;
      world.elapsedMs = TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);

      const firstField = world.attackWaveState?.safeRoomDistanceField;
      expect(firstField).toBeDefined();

      world.elapsedMs += TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);
      expect(world.attackWaveState?.safeRoomDistanceField).toBe(firstField);

      world.floorMap = makeMapWithSafeRoom({ widthTiles: 90, heightTiles: 90 });
      world.elapsedMs += TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);
      const secondField = world.attackWaveState?.safeRoomDistanceField;
      expect(secondField).toBeDefined();
      expect(secondField).not.toBe(firstField);

      world.clearedSafeRoomMap = world.floorMap;
      world.clearedSafeRoomIds.add(1);
      world.elapsedMs += TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);
      expect(world.attackWaveState?.safeRoomDistanceField).not.toBe(secondField);

      const barrier = createRingBarrier(world, 400, 400, 8, 'fence');
      world.elapsedMs += TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);
      const withBarrierField = world.attackWaveState?.safeRoomDistanceField;
      expect(withBarrierField).toBeDefined();
      expect(withBarrierField).not.toBe(secondField);

      dropBarrier(world, barrier);
      world.elapsedMs += TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);
      expect(world.attackWaveState?.safeRoomDistanceField).not.toBe(withBarrierField);
    });

    /**
     * Production `createRingWallBarrier` seal coverage.
     *
     * `createRingWallBarrier` stores an ANALYTIC ring shape that owns no tiles
     * and can be thinner than one tile. Sampling only tile centres therefore
     * misses a wall that crosses the edge between two adjacent centres, and the
     * BFS happily reports a path out of a physically sealed arena — suppressing
     * a wave that is actually due. Wall band below is 9..10 ft from the player,
     * while the surrounding tile centres sit at 8 ft and 12 ft, so every centre
     * sample says "no wall".
     */
    describe('analytic ring wall (createRingWallBarrier)', () => {
      const PLAYER_TILE = 30;
      const PLAYER_FT = PLAYER_TILE * 4 + 2; // 122 ft, exactly a tile centre

      function makeSealMap(): FloorMap {
        const w = 60;
        const h = 60;
        const config: MapConfig = {
          widthTiles: w,
          heightTiles: h,
          tileSizeFt: 4,
          biome: BiomeType.DUNGEON,
          seed: 7,
          roomWidthRange: [4, 8],
          roomHeightRange: [4, 8],
          maxRooms: 2,
          floorDensity: 1,
        };
        const tileMap = new TileMap(w, h);
        tileMap.fill(TilePresets.FLOOR);
        const graph = new RoomGraph();
        graph.add({ x: 1, y: 1, width: 3, height: 3 }, [], [], RoomRole.SAFE);
        return new FloorMap(config, tileMap, graph, new Uint8Array(w * h), {
          x: PLAYER_TILE,
          y: PLAYER_TILE,
        });
      }

      function makeSealWorld(): ReturnType<typeof createTestWorld> {
        const world = createTestWorld();
        world.floorId = 'floor1';
        world.floorMap = makeSealMap();
        attachBarriersToFloorMap(world);
        spawnPlayer(world, PLAYER_FT, PLAYER_FT);
        world.attackWaveFlags.attackWaves = true;
        world.elapsedMs = TUNING.attackWaves.intervalMs;
        return world;
      }

      it('control: with no wall the safe room is reachable, so the wave is suppressed', () => {
        const original = TUNING.attackWaves.safeRoomSuppressionTiles;
        TUNING.attackWaves.safeRoomSuppressionTiles = 500;
        try {
          const world = makeSealWorld();
          attackWaveSystem(world);
          expect(enemyCount(world)).toBe(0);
        } finally {
          TUNING.attackWaves.safeRoomSuppressionTiles = original;
        }
      });

      it('a sub-tile ring wall seals the arena, so the safe room is unreachable and the wave fires', () => {
        const original = TUNING.attackWaves.safeRoomSuppressionTiles;
        TUNING.attackWaves.safeRoomSuppressionTiles = 500;
        try {
          const world = makeSealWorld();
          // 1 ft-thick band at radius 9..10 ft — no tile centre lands inside it.
          createRingWallBarrier(world, PLAYER_FT, PLAYER_FT, 10, 1, 'fence');
          for (let d = -3; d <= 3; d += 1) {
            const centre = (PLAYER_TILE + d) * 4 + 2;
            expect(world.floorMap!.hasBarrierAtPoint(centre, PLAYER_FT)).toBe(false);
          }

          attackWaveSystem(world);

          expect(world.attackWaveState?.safeRoomDistanceField).toBeDefined();
          expect(enemyCount(world)).toBe(TUNING.attackWaves.packSize);
        } finally {
          TUNING.attackWaves.safeRoomSuppressionTiles = original;
        }
      });
    });
  });

  describe('run-state gating', () => {
    it.each(['game_over', 'level_up', 'paused', 'loadout'] as const)(
      'is inert (no spawns, no RNG draws) while world.state is %s',
      (state) => {
        const world = createTestWorld();
        world.floorId = 'floor1';
        world.floorMap = makeMapWithSafeRoom({ widthTiles: 80, heightTiles: 80 });
        spawnPlayer(world, 400, 400);
        world.attackWaveFlags.attackWaves = true;
        world.state = state;

        const rngSpy = vi.spyOn(world.rng, 'next');
        const nextIntSpy = vi.spyOn(world.rng, 'nextInt');

        for (let i = 0; i < 5; i += 1) {
          world.elapsedMs += TUNING.attackWaves.intervalMs;
          attackWaveSystem(world);
        }

        expect(rngSpy).not.toHaveBeenCalled();
        expect(nextIntSpy).not.toHaveBeenCalled();
        expect(enemyCount(world)).toBe(0);
        expect(world.attackWaveState).toBeUndefined();
      },
    );

    it('resumes spawning once the run returns to playing', () => {
      const world = createTestWorld();
      world.floorId = 'floor1';
      world.floorMap = makeMapWithSafeRoom({ widthTiles: 80, heightTiles: 80 });
      spawnPlayer(world, 400, 400);
      world.attackWaveFlags.attackWaves = true;

      world.state = 'game_over';
      world.elapsedMs = TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);
      expect(enemyCount(world)).toBe(0);

      world.state = 'playing';
      attackWaveSystem(world);
      expect(enemyCount(world)).toBe(TUNING.attackWaves.packSize);
    });
  });

  describe('off-screen spawn placement', () => {
    it('places every wave spawn at or beyond the configured ring radius, which is >= half the viewport diagonal', () => {
      const world = createTestWorld();
      world.floorId = 'floor1';
      world.floorMap = makeMapWithSafeRoom({ widthTiles: 200, heightTiles: 200, tileSizeFt: 4 });
      const playerEid = spawnPlayer(world, 400, 400);
      world.attackWaveFlags.attackWaves = true;

      const viewportWidthFt = pxToFt(GAME.WIDTH / floor1Config.camera.zoom);
      const viewportHeightFt = pxToFt(GAME.HEIGHT / floor1Config.camera.zoom);
      const minRingRadiusFt = Math.hypot(viewportWidthFt / 2, viewportHeightFt / 2);
      expect(TUNING.attackWaves.spawnRingRadiusFt).toBeGreaterThanOrEqual(minRingRadiusFt);

      world.elapsedMs = TUNING.attackWaves.intervalMs;
      attackWaveSystem(world);

      const rats = query(world.ecs, [Enemy]);
      expect(rats.length).toBeGreaterThan(0);

      const px = world.stores.position.x[playerEid]!;
      const py = world.stores.position.y[playerEid]!;
      for (const eid of rats) {
        const dx = world.stores.position.x[eid]! - px;
        const dy = world.stores.position.y[eid]! - py;
        const dist = Math.hypot(dx, dy);
        expect(dist).toBeGreaterThanOrEqual(TUNING.attackWaves.spawnRingRadiusFt - 0.01);
      }
    });
  });

  describe('determinism', () => {
    it('same seed produces identical wave timing, count, and spawn positions', () => {
      function runWorld() {
        const world = createTestWorld({ seed: 777 });
        world.floorId = 'floor1';
        world.floorMap = makeMapWithSafeRoom({ widthTiles: 200, heightTiles: 200, tileSizeFt: 4 });
        spawnPlayer(world, 400, 400);
        world.attackWaveFlags.attackWaves = true;
        world.elapsedMs = TUNING.attackWaves.intervalMs;
        attackWaveSystem(world);
        const rats = Array.from(query(world.ecs, [Enemy]));
        return rats
          .map((eid) => ({ x: world.stores.position.x[eid], y: world.stores.position.y[eid] }))
          .sort((a, b) => a.x! - b.x! || a.y! - b.y!);
      }

      const first = runWorld();
      const second = runWorld();

      expect(first.length).toBeGreaterThan(0);
      expect(first).toEqual(second);
    });
  });

  describe('maxAliveFromWaves cap', () => {
    it('never exceeds the cap, and recount ignores dead lingering corpses so new rats can spawn', () => {
      const world = createTestWorld();
      world.floorId = 'floor1';
      world.floorMap = makeMapWithSafeRoom({ widthTiles: 200, heightTiles: 200, tileSizeFt: 4 });
      spawnPlayer(world, 400, 400);
      world.attackWaveFlags.attackWaves = true;

      const originalMaxAlive = TUNING.attackWaves.maxAliveFromWaves;
      const originalPackSize = TUNING.attackWaves.packSize;
      TUNING.attackWaves.maxAliveFromWaves = 5;
      TUNING.attackWaves.packSize = 10;

      try {
        world.elapsedMs = TUNING.attackWaves.intervalMs;
        attackWaveSystem(world);
        expect(enemyCount(world)).toBe(5);

        // Further waves must not exceed the cap.
        world.elapsedMs += TUNING.attackWaves.intervalMs;
        attackWaveSystem(world);
        expect(enemyCount(world)).toBe(5);

        // Kill all tracked wave rats through the runtime death-linger path.
        const rats = query(world.ecs, [Enemy, AttackWaveRat]);
        for (const eid of rats) {
          world.stores.health.current[eid] = 0;
        }
        dropSystem(world, { spawnLoot: false });
        expect(query(world.ecs, [DeathTimer]).length).toBe(5);
        expect(enemyCount(world)).toBe(5);

        world.elapsedMs += TUNING.attackWaves.intervalMs;
        attackWaveSystem(world);
        expect(enemyCount(world)).toBe(10);
      } finally {
        TUNING.attackWaves.maxAliveFromWaves = originalMaxAlive;
        TUNING.attackWaves.packSize = originalPackSize;
      }
    });
  });

  describe('wiring', () => {
    it('is registered in floor-main-scene-options postSystems, without disturbing the locked spawnerSystem preSystems adjacency contract', () => {
      const options = createFloorMainSceneOptions('floor1');
      const pre = options.preSystems;
      const post = options.postSystems;

      // Wired into the real sim-side pipeline via postSystems, not a lab-only path.
      expect(post).toContain(attackWaveSystem);
      // Must not be inserted into preSystems at all: floor1-main-scene-options.test.ts
      // locks `preSystems.slice(indexOf(spawnerSystem) + 1)` to equal exactly
      // `afterSpawnerSystems`.
      expect(pre).not.toContain(attackWaveSystem);

      const spawnerIdx = pre.indexOf(spawnerSystem);
      const arenaIdx = pre.indexOf(spawnerArenaSystem);
      expect(spawnerIdx).toBeGreaterThanOrEqual(0);
      // Must not be inserted between spawnerArenaSystem and spawnerSystem.
      expect(arenaIdx).toBeLessThan(spawnerIdx);
    });
  });
});
