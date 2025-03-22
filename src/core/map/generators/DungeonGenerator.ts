/**
 * DungeonGenerator — room-based dungeon layout using rot-js.
 *
 * Produces rooms connected by corridors with automatic door placement.
 * Best for: castle, dungeon, and structured interior biomes.
 *
 * When constructed with `{ roomVariety: true }`, applies post-processing for:
 * - Round rooms (ellipse-inscribed interiors)
 * - L-shaped rooms (one quadrant filled)
 * - Wide corridors (1-tile perpendicular expansion)
 * - Diagonal shortcuts (Bresenham diagonal paths between nearby rooms)
 */

import { Map as ROTMap, RNG } from 'rot-js';
import type { MapConfig, DoorLocation, RoomBounds } from '../../../shared/map-types';
import { TilePresets, TerrainType, RoomRole } from '../../../shared/map-types';
import { SeededRandom } from '../../../shared/random';
import { TileMap } from '../TileMap';
import { RoomGraph } from '../RoomGraph';
import { FloorMap } from '../FloorMap';
import { restoreRoomInterior } from '../special-rooms.js';
import type { MapGenerator } from './types';

// ─── Extracted pipeline modules (in-layer split; see ./dungeon/) ─────────────
// The generator's pure helper passes live in cohesive modules under ./dungeon/.
// generate() below orchestrates them; every signature is preserved unchanged.
import { computeRoomAdjacency } from './dungeon/adjacency';
import { ensureRoomsReachable, cullIsolatedFloorTiles } from './dungeon/reachability';
import { expandDoorsForWideCorridors, pruneInaccessibleDoors } from './dungeon/doors';
import { preAssignRoles } from './dungeon/roles';
import {
  sealSpecialRoomPerimeters,
  buildSpecialRoomWalls,
  paintRoomFloor,
} from './dungeon/room-fill';
import { applyRoomShapes } from './dungeon/room-shapes';
import { widenCorridors, addDiagonalShortcuts } from './dungeon/corridors';
import { buildCaveProtectedMask, carveCaveRegions } from './dungeon/caves';

/**
 * `ensureRoomsReachable` now lives in ./dungeon/reachability. Re-export it from
 * this module so existing importers (and unit tests) keep their current import
 * path — the public surface is unchanged by the split.
 */
export { ensureRoomsReachable };

/** Default minimum bounds width (tiles, walls included) for BOSS_STAIR and SAFE rooms. */
export const SPECIAL_ROOM_MIN_WIDTH = 9;
/** Default minimum bounds height (tiles, walls included) for BOSS_STAIR and SAFE rooms. */
export const SPECIAL_ROOM_MIN_HEIGHT = 9;

export interface DungeonGeneratorOptions {
  /** When true, applies round/L-shaped rooms, wide corridors, and diagonal shortcuts. */
  readonly roomVariety?: boolean;
  /**
   * When true, carves cave sub-regions with curved/non-linear tunnels and
   * non-uniform cave chambers inside dungeon layouts.
   */
  readonly caveRegions?: boolean;
  /**
   * Minimum bounds width (tiles, walls included) that a room must have to be
   * eligible for the BOSS_STAIR or SAFE role. Defaults to SPECIAL_ROOM_MIN_WIDTH.
   * When no candidate meets the minimum, the farthest room is used as a fallback
   * so generation never fails on small test maps.
   */
  readonly specialRoomMinWidth?: number;
  /**
   * Minimum bounds height (tiles, walls included) that a room must have to be
   * eligible for the BOSS_STAIR or SAFE role. Defaults to SPECIAL_ROOM_MIN_HEIGHT.
   */
  readonly specialRoomMinHeight?: number;
}

export class DungeonGenerator implements MapGenerator {
  readonly name = 'DungeonGenerator';
  private readonly roomVariety: boolean;
  private readonly caveRegions: boolean;
  private readonly specialRoomMinWidth: number;
  private readonly specialRoomMinHeight: number;

  constructor(options: DungeonGeneratorOptions = {}) {
    this.roomVariety = options.roomVariety ?? false;
    this.caveRegions = options.caveRegions ?? false;
    this.specialRoomMinWidth = options.specialRoomMinWidth ?? SPECIAL_ROOM_MIN_WIDTH;
    this.specialRoomMinHeight = options.specialRoomMinHeight ?? SPECIAL_ROOM_MIN_HEIGHT;
  }

  generate(config: MapConfig, rng: SeededRandom): FloorMap {
    const { widthTiles: w, heightTiles: h } = config;

    const tileMap = new TileMap(w, h);
    const terrain = new Uint8Array(w * h);
    const roomGraph = new RoomGraph();

    // Seed rot-js's internal RNG for deterministic generation
    RNG.setSeed(config.seed);

    // rot-js Uniform generator — evenly distributed rooms with corridors
    const rotMap = new ROTMap.Uniform(w, h, {
      roomWidth: [config.roomWidthRange[0], config.roomWidthRange[1]],
      roomHeight: [config.roomHeightRange[0], config.roomHeightRange[1]],
      roomDugPercentage: config.floorDensity,
    });

    rotMap.create((x: number, y: number, value: number) => {
      const idx = y * w + x;
      if (value === 0) {
        tileMap.flags[idx] = TilePresets.FLOOR;
        terrain[idx] = TerrainType.STONE_FLOOR;
      } else {
        tileMap.flags[idx] = TilePresets.WALL;
        terrain[idx] = TerrainType.STONE_WALL;
      }
    });

    const rotRooms = rotMap.getRooms();

    // Extract rooms from rot-js results
    const roomIndexMap = new Map<number, number>(); // rot-js room index → our room ID

    for (let i = 0; i < rotRooms.length; i++) {
      const rotRoom = rotRooms[i]!;
      const bounds: RoomBounds = {
        x: rotRoom.getLeft() - 1,
        y: rotRoom.getTop() - 1,
        width: rotRoom.getRight() - rotRoom.getLeft() + 3,
        height: rotRoom.getBottom() - rotRoom.getTop() + 3,
      };
      const roomId = roomGraph.add(bounds);
      roomIndexMap.set(i, roomId);
    }

    // Extract doors from rot-js rooms and place them.
    // Note: room adjacency is NOT derived here. A door opens onto a corridor,
    // not directly onto the target room, so the target is almost never within
    // the other room's bounds. Real connectivity is computed below by
    // flood-filling the corridor/door tiles (see "Derive room adjacency").
    for (let i = 0; i < rotRooms.length; i++) {
      const rotRoom = rotRooms[i]!;
      const roomId = roomIndexMap.get(i)!;
      const room = roomGraph.get(roomId)!;
      const doors: DoorLocation[] = [];

      rotRoom.getDoors((x: number, y: number) => {
        const idx = y * w + x;
        tileMap.flags[idx] = TilePresets.DOOR_CLOSED;
        terrain[idx] = TerrainType.DOOR;
        doors.push({ x, y, connectsTo: -1 });
      });

      Object.assign(roomGraph.get(roomId)!, { ...room, doors });
    }

    // Mark corridors with corridor terrain type
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (
          tileMap.flags[idx] === TilePresets.FLOOR &&
          terrain[idx] === TerrainType.STONE_FLOOR &&
          roomGraph.getRoomAt(x, y) === -1
        ) {
          terrain[idx] = TerrainType.CORRIDOR;
        }
      }
    }

    // Pre-assign room roles before room variety so that SAFE and BOSS_STAIR rooms
    // can be excluded from shape post-processing. The assignment also runs a
    // connectivity check to ensure that sealing the chosen rooms' perimeters
    // cannot disconnect other rooms from the spawn point.
    preAssignRoles(
      roomGraph,
      tileMap,
      terrain,
      w,
      this.specialRoomMinWidth,
      this.specialRoomMinHeight,
    );

    // Seal perimeter walls of special rooms. rot-js sometimes places a corridor
    // tile at a position that falls on the boundary of an adjacent room's bounds.
    // This would leave an unintended opening on the special room's wall before
    // variety even runs; sealing here guarantees walls+doors from the start.
    sealSpecialRoomPerimeters(tileMap, terrain, roomGraph, w);

    // Collect perimeter tile indices for SAFE and BOSS_STAIR rooms. These tiles
    // must never be carved into corridors by widening or diagonal shortcuts —
    // that would create unintended openings in otherwise fully-walled rooms.
    const protectedWalls = buildSpecialRoomWalls(roomGraph, w);

    // --- Room variety post-processing (BASIC_UNDERGROUND and opt-in biomes) ---
    if (this.roomVariety) {
      applyRoomShapes(tileMap, terrain, roomGraph, w, rng);
      const widenedCorridorTiles = widenCorridors(tileMap, terrain, w, h, rng, protectedWalls);
      addDiagonalShortcuts(tileMap, terrain, roomGraph, w, h, rng, protectedWalls);
      expandDoorsForWideCorridors(tileMap, terrain, roomGraph, w, widenedCorridorTiles);
    }

    if (this.caveRegions) {
      const caveProtectedMask = buildCaveProtectedMask(roomGraph, w, h);
      carveCaveRegions(tileMap, terrain, roomGraph, w, h, caveProtectedMask, config.seed);
    }

    for (const room of roomGraph.getAll()) {
      if (room.role !== RoomRole.SAFE && room.role !== RoomRole.BOSS_STAIR) continue;
      restoreRoomInterior(tileMap.flags, terrain, w, room);
    }

    // Room adjacency is computed AFTER all tile-modifying passes (variety,
    // cave carving, ensureRoomsReachable, culling) to guarantee the neighbor
    // sets and door connectsTo values reflect the final tile state. The call
    // is deferred to after those passes — see computeRoomAdjacency below.

    // Room roles were pre-assigned before room variety (see preAssignRoles above).
    // Now compute the player's exact spawn tile — adjust room 0's bounds centre to
    // the nearest passable tile in case variety reshaped the interior geometry.
    const spawnRoom = roomGraph.get(0);
    let playerSpawn = { x: Math.floor(w / 2), y: Math.floor(h / 2) };
    if (spawnRoom) {
      const centerX = Math.floor(spawnRoom.bounds.x + spawnRoom.bounds.width / 2);
      const centerY = Math.floor(spawnRoom.bounds.y + spawnRoom.bounds.height / 2);
      playerSpawn = { x: centerX, y: centerY };
      // When a corridor or adjacent room has partially filled the room's interior,
      // the computed bounds-center can land on a wall tile. Spiral outward from
      // the center (staying within the interior region, one tile inside the walls)
      // to find the nearest passable tile so the player never spawns inside a wall.
      if (!tileMap.isPassable(centerX, centerY)) {
        const ix = spawnRoom.bounds.x + 1;
        const iy = spawnRoom.bounds.y + 1;
        const maxX = spawnRoom.bounds.x + spawnRoom.bounds.width - 2;
        const maxY = spawnRoom.bounds.y + spawnRoom.bounds.height - 2;
        const maxR = Math.max(spawnRoom.bounds.width, spawnRoom.bounds.height);
        found: for (let r = 1; r <= maxR; r++) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              // Only test ring perimeter so we spiral outward without redundancy.
              if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
              const tx = centerX + dx;
              const ty = centerY + dy;
              if (tx >= ix && tx <= maxX && ty >= iy && ty <= maxY && tileMap.isPassable(tx, ty)) {
                playerSpawn = { x: tx, y: ty };
                break found;
              }
            }
          }
        }
      }
    }

    // Paint special room floors now that variety has finished.
    const bossRoom = roomGraph.getFirstRoomByRole(RoomRole.BOSS_STAIR);
    const safeRoom = roomGraph.getFirstRoomByRole(RoomRole.SAFE);
    if (bossRoom) paintRoomFloor(bossRoom.id, roomGraph, w, terrain, TerrainType.BOSS_STAIR_FLOOR);
    if (safeRoom) paintRoomFloor(safeRoom.id, roomGraph, w, terrain, TerrainType.SAFE_ROOM_FLOOR);

    // Guarantee every room is reachable from spawn BEFORE culling. rot-js's
    // Uniform generator occasionally emits a room (typically the farthest one —
    // which preAssignRoles then chooses as BOSS_STAIR) whose only corridor link
    // fails to reach the spawn component. cullIsolatedFloorTiles would then wall
    // off that room's entire interior, and on Floor 1 that strands the staircase
    // (the floor exit) in solid rock, making the floor unwinnable by any weapon
    // or AI. Carve a minimal deterministic connector through the isolated room's
    // door so the staircase, shop, and objective rooms are always reachable.
    // This is a strict no-op when a room is already connected, so well-formed
    // seeds keep byte-identical maps. It consumes no RNG, preserving determinism.
    ensureRoomsReachable(tileMap, terrain, roomGraph, w, h, playerSpawn);

    // Remove any floor/corridor tiles that cannot be reached from spawn even when
    // all doors are treated as open. These isolated pockets arise from room-shape
    // post-processing (ellipse, L-shape, corridor widening) and would trap the
    // player or enemies in permanently unreachable areas.
    cullIsolatedFloorTiles(tileMap, terrain, w, h, playerSpawn);

    if (this.caveRegions) {
      pruneInaccessibleDoors(roomGraph, tileMap, terrain, w);
    }

    // Compute room adjacency AFTER all tile-modifying passes: cave carving
    // (carveCaveRegions), ensureRoomsReachable, cullIsolatedFloorTiles, and
    // pruneInaccessibleDoors. Running here guarantees that:
    //   1. Corridors preserved by carveTile's CORRIDOR guard are picked up.
    //   2. Any connectors carved by ensureRoomsReachable are included.
    //   3. Doors pruned by pruneInaccessibleDoors are excluded from connectsTo.
    computeRoomAdjacency(terrain, roomGraph, w, h);

    return new FloorMap(config, tileMap, roomGraph, terrain, playerSpawn);
  }
}
