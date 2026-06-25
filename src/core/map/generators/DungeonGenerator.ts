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
import { TilePresets, TileFlags, TerrainType, RoomRole } from '../../../shared/map-types';
import type { SeededRandom } from '../../../shared/random';
import { TileMap } from '../TileMap';
import { RoomGraph } from '../RoomGraph';
import { FloorMap } from '../FloorMap';
import type { MapGenerator } from './types';

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

type RoomDoorSide = 'left' | 'right' | 'top' | 'bottom';

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

    // Rooms are linked by corridors (and occasionally a shared door), so we
    // flood-fill connected components over CORRIDOR + DOOR tiles and treat every
    // room touching the same component as a mutual neighbor. This is the source
    // of truth for the RoomGraph adjacency that pathfinding, AI, and
    // welcome-sign placement depend on — the previous bounds-proximity check
    // almost always failed because doors open onto corridors, not rooms.
    {
      const isConnector = (idx: number): boolean =>
        terrain[idx] === TerrainType.CORRIDOR || terrain[idx] === TerrainType.DOOR;

      const componentId = new Int32Array(w * h).fill(-1);
      const componentRooms: Set<number>[] = [];

      for (let startY = 0; startY < h; startY++) {
        for (let startX = 0; startX < w; startX++) {
          const startIdx = startY * w + startX;
          if (componentId[startIdx] !== -1 || !isConnector(startIdx)) continue;

          const cid = componentRooms.length;
          const roomsTouched = new Set<number>();
          const stack: number[] = [startIdx];
          componentId[startIdx] = cid;

          while (stack.length > 0) {
            const idx = stack.pop()!;
            const cx = idx % w;
            const cy = (idx - cx) / w;
            const adj: ReadonlyArray<readonly [number, number]> = [
              [cx + 1, cy],
              [cx - 1, cy],
              [cx, cy + 1],
              [cx, cy - 1],
            ];
            for (const [nx, ny] of adj) {
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              const nIdx = ny * w + nx;
              // A room interior orthogonally adjacent to this connector is linked here.
              const roomAt = roomGraph.getRoomAt(nx, ny);
              if (roomAt !== -1) roomsTouched.add(roomAt);
              if (componentId[nIdx] === -1 && isConnector(nIdx)) {
                componentId[nIdx] = cid;
                stack.push(nIdx);
              }
            }
          }
          componentRooms.push(roomsTouched);
        }
      }

      // Build mutual adjacency: rooms sharing a corridor component are neighbors.
      const neighborSets: Set<number>[] = roomGraph.getAll().map(() => new Set<number>());
      for (const rooms of componentRooms) {
        const ids = [...rooms];
        for (let a = 0; a < ids.length; a++) {
          for (let b = a + 1; b < ids.length; b++) {
            neighborSets[ids[a]!]!.add(ids[b]!);
            neighborSets[ids[b]!]!.add(ids[a]!);
          }
        }
      }

      // Persist neighbors and point each door at a room it actually reaches.
      // RoomData.doors/neighbors (and DoorLocation.connectsTo) are readonly, so
      // rebuild them as fresh values and write them back via Object.assign.
      const allRooms = roomGraph.getAll();
      for (let id = 0; id < allRooms.length; id++) {
        const room = roomGraph.get(id)!;
        const resolvedDoors = room.doors.map((door) => {
          const comp = componentId[door.y * w + door.x] ?? -1;
          let target = -1;
          if (comp !== -1) {
            for (const r of componentRooms[comp]!) {
              if (r !== id) {
                target = r;
                break;
              }
            }
          }
          return { ...door, connectsTo: target };
        });
        Object.assign(room, {
          doors: resolvedDoors,
          neighbors: [...neighborSets[id]!],
        });
      }
    }

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
    pruneInaccessibleDoors(roomGraph, tileMap, terrain, w);

    return new FloorMap(config, tileMap, roomGraph, terrain, playerSpawn);
  }
}

/**
 * Flood-fill from the player spawn, treating all PASSABLE tiles and DOOR tiles
 * as walkable. Any passable non-door tile that is NOT reached is converted to a
 * wall, eliminating isolated floor pockets created by room-shape post-processing.
 */
function cullIsolatedFloorTiles(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  h: number,
  playerSpawn: { x: number; y: number },
): void {
  const visited = new Uint8Array(w * h);
  const stack: number[] = [];

  const startIdx = playerSpawn.y * w + playerSpawn.x;
  visited[startIdx] = 1;
  stack.push(startIdx);

  while (stack.length > 0) {
    const idx = stack.pop()!;
    const cx = idx % w;
    const cy = (idx - cx) / w;

    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as [number, number][]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx]) continue;
      const flags = tileMap.flags[nIdx]!;
      // Treat doors (open or closed) as walkable for connectivity purposes
      const isDoor = (flags & TileFlags.DOOR) !== 0;
      const isPassable = (flags & TileFlags.PASSABLE) !== 0;
      if (!isPassable && !isDoor) continue;
      visited[nIdx] = 1;
      stack.push(nIdx);
    }
  }

  // Wall off any passable non-door tile that was not reached
  for (let idx = 0; idx < w * h; idx++) {
    if (visited[idx]) continue;
    const flags = tileMap.flags[idx]!;
    const isDoor = (flags & TileFlags.DOOR) !== 0;
    const isPassable = (flags & TileFlags.PASSABLE) !== 0;
    if (isPassable && !isDoor) {
      tileMap.flags[idx] = TilePresets.WALL;
      terrain[idx] = TerrainType.STONE_WALL;
    }
  }
}

/**
 * Flood-fill from a start tile over PASSABLE + DOOR tiles, returning a visited
 * bitmap. Mirrors the connectivity model used by cullIsolatedFloorTiles and the
 * AI pathfinder (closed doors are walkable for reachability — the door system
 * opens them on approach). When `blocked` is supplied, tiles flagged in it are
 * treated as impassable, letting callers measure reachability that avoids a
 * particular region (e.g. the locked boss-stair room).
 */
function floodReachableTiles(
  tileMap: TileMap,
  w: number,
  h: number,
  start: { x: number; y: number },
  blocked?: Uint8Array | null,
): Uint8Array {
  const visited = new Uint8Array(w * h);
  const startIdx = start.y * w + start.x;
  if (startIdx < 0 || startIdx >= w * h) return visited;
  if (blocked && blocked[startIdx]) return visited;
  visited[startIdx] = 1;
  const stack: number[] = [startIdx];
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const cx = idx % w;
    const cy = (idx - cx) / w;
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as [number, number][]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx]) continue;
      if (blocked && blocked[nIdx]) continue;
      const flags = tileMap.flags[nIdx]!;
      if ((flags & TileFlags.PASSABLE) === 0 && (flags & TileFlags.DOOR) === 0) continue;
      visited[nIdx] = 1;
      stack.push(nIdx);
    }
  }
  return visited;
}

/** Does the room have ≥1 passable interior tile, and is any of them reachable? */
function roomInteriorStatus(
  tileMap: TileMap,
  w: number,
  room: { bounds: RoomBounds },
  reachable: Uint8Array,
): { hasInterior: boolean; connected: boolean } {
  const { x, y, width, height } = room.bounds;
  let hasInterior = false;
  for (let ty = y + 1; ty < y + height - 1; ty++) {
    for (let tx = x + 1; tx < x + width - 1; tx++) {
      const idx = ty * w + tx;
      if ((tileMap.flags[idx]! & TileFlags.PASSABLE) === 0) continue;
      hasInterior = true;
      if (reachable[idx] === 1) return { hasInterior: true, connected: true };
    }
  }
  return { hasInterior, connected: false };
}

/** Build a mask covering every tile inside a room's bounds plus its door tiles. */
function buildRoomBlockMask(
  room: { bounds: RoomBounds; doors: readonly DoorLocation[] },
  w: number,
  h: number,
): Uint8Array {
  const mask = new Uint8Array(w * h);
  const { x, y, width, height } = room.bounds;
  for (let ty = Math.max(0, y); ty < Math.min(h, y + height); ty++) {
    for (let tx = Math.max(0, x); tx < Math.min(w, x + width); tx++) {
      mask[ty * w + tx] = 1;
    }
  }
  for (const door of room.doors) {
    if (door.x >= 0 && door.y >= 0 && door.x < w && door.y < h) {
      mask[door.y * w + door.x] = 1;
    }
  }
  return mask;
}

/**
 * Guarantee that every room is reachable from the player spawn before isolated
 * floor tiles are culled. rot-js's Uniform generator occasionally emits a room
 * whose only corridor link fails to reach the spawn component; cullIsolatedFloorTiles
 * would then wall off that room's entire interior. On Floor 1 the affected room is
 * usually the farthest one — which preAssignRoles tags BOSS_STAIR — so its loss
 * strands the staircase (the floor exit) in solid rock and makes the floor
 * unwinnable by any weapon or AI.
 *
 * Two phases keep locked-door gating intact:
 * 1. Connect every non-spawn, non-boss room so it is reachable WITHOUT passing
 *    through the (locked) boss-stair room. Gate-quest rooms (shop, fetch item)
 *    therefore never deadlock behind the boss doors.
 * 2. Connect the boss-stair room itself, routed to its door so entry is still
 *    governed by the lock.
 *
 * Determinism & safety:
 * - Consumes NO RNG, so downstream procedural placement is unaffected.
 * - A strict no-op for already-reachable rooms (including rooms legitimately
 *   reachable only through the boss room) — a well-formed seed's tile flags and
 *   terrain are left byte-identical.
 *
 * Exported for unit testing. Not part of the public map API.
 */
export function ensureRoomsReachable(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
  h: number,
  playerSpawn: { x: number; y: number },
): void {
  const bossRoom = roomGraph.getFirstRoomByRole(RoomRole.BOSS_STAIR);
  const bossBlocked = bossRoom ? buildRoomBlockMask(bossRoom, w, h) : null;

  // Phase 1 — every non-spawn, non-boss room reachable without the boss room.
  let reachableNoBoss = floodReachableTiles(tileMap, w, h, playerSpawn, bossBlocked);
  for (const room of roomGraph.getAll()) {
    if (room.role === RoomRole.SPAWN) continue;
    if (bossRoom && room.id === bossRoom.id) continue;
    const { width, height } = room.bounds;
    if (width < 3 || height < 3) continue;

    const status = roomInteriorStatus(tileMap, w, room, reachableNoBoss);
    if (!status.hasInterior || status.connected) continue;

    // Reachable only through the boss room? Leave it untouched — floor1Scenario
    // already declines to place pre-boss quests in such rooms, and rewriting them
    // would perturb otherwise well-formed seeds. Only TRULY isolated rooms (sealed
    // off even with every door open) get a carved connector.
    const reachableOpen = floodReachableTiles(tileMap, w, h, playerSpawn);
    if (roomInteriorStatus(tileMap, w, room, reachableOpen).connected) continue;

    if (carveRoomConnector(tileMap, terrain, w, h, room, reachableNoBoss, bossBlocked)) {
      reachableNoBoss = floodReachableTiles(tileMap, w, h, playerSpawn, bossBlocked);
    }
  }

  // Phase 2 — the boss-stair room itself, routed via its door (lock still gates entry).
  if (bossRoom) {
    const { width, height } = bossRoom.bounds;
    if (width >= 3 && height >= 3) {
      const reachableOpen = floodReachableTiles(tileMap, w, h, playerSpawn);
      const status = roomInteriorStatus(tileMap, w, bossRoom, reachableOpen);
      if (status.hasInterior && !status.connected) {
        carveRoomConnector(tileMap, terrain, w, h, bossRoom, reachableOpen, null);
      }
    }
  }
}

/**
 * Carve a minimal corridor connecting an isolated room to the spawn-reachable
 * component. Performs a breadth-first search outward from the room's door tiles
 * (4-connected, through walls) to the nearest reachable tile, then converts the
 * intervening wall tiles to passable corridor floor. Also opens each door inward
 * by ensuring its interior-adjacent tile is passable. When `blocked` is supplied,
 * those tiles are never traversed or carved, so the connector avoids a forbidden
 * region (the locked boss room). Deterministic (fixed neighbour order, BFS by
 * insertion order). Returns true when a connector was carved.
 */
function carveRoomConnector(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  h: number,
  room: { id: number; bounds: RoomBounds; doors: readonly DoorLocation[] },
  reachable: Uint8Array,
  blocked: Uint8Array | null,
): boolean {
  const { x, y, width, height } = room.bounds;
  const isRoomPerimeterNonDoor = (idx: number): boolean => {
    if (room.doors.length === 0) return false;
    const tx = idx % w;
    const ty = (idx - tx) / w;
    const onPerimeter =
      tx >= x &&
      tx < x + width &&
      ty >= y &&
      ty < y + height &&
      (tx === x || tx === x + width - 1 || ty === y || ty === y + height - 1);
    if (!onPerimeter) return false;
    const flags = tileMap.flags[idx]!;
    return (flags & TileFlags.DOOR) === 0;
  };

  // Seed BFS from door tiles when present (preserves door-gated entry); fall back
  // to the interior perimeter for the rare door-less room.
  const seeds: number[] = [];
  if (room.doors.length > 0) {
    for (const door of room.doors) {
      seeds.push(door.y * w + door.x);
      // Open the door inward so the exterior connector reaches the interior.
      const side = getDoorSide(room.bounds, door);
      const inward: [number, number] =
        side === 'left'
          ? [door.x + 1, door.y]
          : side === 'right'
            ? [door.x - 1, door.y]
            : side === 'top'
              ? [door.x, door.y + 1]
              : [door.x, door.y - 1];
      const [ix, iy] = inward;
      if (ix >= 0 && iy >= 0 && ix < w && iy < h) {
        const iIdx = iy * w + ix;
        const flags = tileMap.flags[iIdx]!;
        if ((flags & TileFlags.PASSABLE) === 0 && (flags & TileFlags.DOOR) === 0) {
          tileMap.flags[iIdx] = TilePresets.FLOOR;
          terrain[iIdx] = TerrainType.CORRIDOR;
        }
      }
    }
  } else {
    for (let tx = x; tx < x + width; tx++) {
      seeds.push(y * w + tx);
      seeds.push((y + height - 1) * w + tx);
    }
    for (let ty = y + 1; ty < y + height - 1; ty++) {
      seeds.push(ty * w + x);
      seeds.push(ty * w + (x + width - 1));
    }
  }

  const parent = new Int32Array(w * h).fill(-2); // -2 unvisited, -1 BFS source
  const queue: number[] = [];
  for (const s of seeds) {
    if (s < 0 || s >= w * h) continue;
    if (blocked && blocked[s]) continue;
    if (parent[s] === -2) {
      parent[s] = -1;
      queue.push(s);
    }
  }

  let target = -1;
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head]!;
    // A tile in the spawn component that we did not start from = bridge endpoint.
    if (reachable[idx] === 1 && parent[idx] !== -1) {
      target = idx;
      break;
    }
    const cx = idx % w;
    const cy = (idx - cx) / w;
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as [number, number][]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (parent[nIdx] !== -2) continue;
      if (blocked && blocked[nIdx]) continue;
      if (isRoomPerimeterNonDoor(nIdx)) continue;
      parent[nIdx] = idx;
      queue.push(nIdx);
    }
  }

  if (target === -1) return false;

  // Carve the bridge: convert non-passable, non-door tiles along the path to
  // corridor floor. Door tiles and already-passable tiles are left untouched.
  let cursor = target;
  let carvedAny = false;
  while (cursor >= 0) {
    const flags = tileMap.flags[cursor]!;
    const isDoor = (flags & TileFlags.DOOR) !== 0;
    const isPassable = (flags & TileFlags.PASSABLE) !== 0;
    if (!isDoor && !isPassable) {
      tileMap.flags[cursor] = TilePresets.FLOOR;
      terrain[cursor] = TerrainType.CORRIDOR;
      carvedAny = true;
    }
    cursor = parent[cursor]!;
  }
  return carvedAny;
}

// ─── Role Pre-Assignment ───────────────────────────────────────────────────

/**
 * Assign room roles before room-variety post-processing so that SAFE and
 * BOSS_STAIR rooms can be excluded from shape transforms and wall protection.
 *
 * Candidates are selected by:
 * 1. Meeting the minimum size (minWidth × minHeight bounds, walls included).
 * 2. Being farthest from the spawn room centre.
 * 3. Preserving dungeon connectivity when their perimeter is sealed — sealing a
 *    perimeter that disconnects other rooms would cause cullIsolatedFloorTiles to
 *    wall off those rooms' interiors. Any candidate that would break connectivity
 *    is skipped in favour of the next best candidate.
 *
 * Fallback order when the ideal candidate is unavailable:
 *   1. Min-size + connectivity-safe (farthest first)
 *   2. Any-size + connectivity-safe (farthest first)
 *   3. Farthest regardless (original behaviour, for tiny test maps with no safe option)
 */
function preAssignRoles(
  roomGraph: RoomGraph,
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  minWidth: number,
  minHeight: number,
): void {
  roomGraph.setRole(0, RoomRole.SPAWN);
  if (roomGraph.count < 2) return;

  const h = terrain.length / w;
  const spawnRoom = roomGraph.get(0)!;
  const refX = Math.floor(spawnRoom.bounds.x + spawnRoom.bounds.width / 2);
  const refY = Math.floor(spawnRoom.bounds.y + spawnRoom.bounds.height / 2);

  type ScoredRoom = { id: number; distanceSq: number };

  const scored: ScoredRoom[] = roomGraph
    .getAll()
    .filter((r) => r.id !== 0)
    .map((room) => {
      const cx = Math.floor(room.bounds.x + room.bounds.width / 2);
      const cy = Math.floor(room.bounds.y + room.bounds.height / 2);
      return { id: room.id, distanceSq: (cx - refX) ** 2 + (cy - refY) ** 2 };
    });
  scored.sort((a, b) => b.distanceSq - a.distanceSq);

  /**
   * Compute the set of tile indices that sealSpecialRoomPerimeters would wall for
   * this room (passable, non-door perimeter tiles).
   */
  function buildSealSet(roomId: number): ReadonlySet<number> {
    const room = roomGraph.get(roomId)!;
    const { x, y, width, height } = room.bounds;
    const doorIdxSet = new Set(room.doors.map((d) => d.y * w + d.x));
    const sealed = new Set<number>();
    const addIfSealable = (tx: number, ty: number): void => {
      const idx = ty * w + tx;
      if (doorIdxSet.has(idx)) return;
      const flags = tileMap.flags[idx]!;
      if ((flags & TileFlags.PASSABLE) !== 0 && (flags & TileFlags.DOOR) === 0) {
        sealed.add(idx);
      }
    };
    for (let tx = x; tx < x + width; tx++) {
      addIfSealable(tx, y);
      addIfSealable(tx, y + height - 1);
    }
    for (let ty = y + 1; ty < y + height - 1; ty++) {
      addIfSealable(x, ty);
      addIfSealable(x + width - 1, ty);
    }
    return sealed;
  }

  /**
   * Return true when treating `sealedTiles` as walls still leaves every room
   * (other than spawn) reachable from the spawn centre via passable/door tiles.
   * Rooms with no doors are skipped (they cannot be door-reachable by definition).
   */
  function sealingPreservesConnectivity(
    sealedTiles: ReadonlySet<number>,
    extraSealedTiles?: ReadonlySet<number>,
  ): boolean {
    if (sealedTiles.size === 0 && (!extraSealedTiles || extraSealedTiles.size === 0)) return true;

    const startIdx = refY * w + refX;
    const visited = new Uint8Array(w * h);
    visited[startIdx] = 1;
    const stack = [startIdx];

    while (stack.length > 0) {
      const idx = stack.pop()!;
      const cx = idx % w;
      const cy = (idx - cx) / w;
      for (const [nx, ny] of [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ] as [number, number][]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nIdx = ny * w + nx;
        if (visited[nIdx]) continue;
        if (sealedTiles.has(nIdx) || extraSealedTiles?.has(nIdx)) continue;
        const flags = tileMap.flags[nIdx]!;
        if ((flags & TileFlags.PASSABLE) === 0 && (flags & TileFlags.DOOR) === 0) continue;
        visited[nIdx] = 1;
        stack.push(nIdx);
      }
    }

    for (const room of roomGraph.getAll()) {
      if (room.id === 0 || room.doors.length === 0) continue;
      if (!room.doors.some((d) => visited[d.y * w + d.x] === 1)) return false;
    }
    return true;
  }

  /**
   * Pick the best candidate for a special role from the given pool.
   * `alreadySealedTiles` holds tiles that will be sealed by previously-assigned
   * special rooms; the new candidate's seal set is combined with it before the
   * connectivity check.
   *
   * Priority:
   *   1. Meets min size AND connectivity-safe (farthest first)
   *   2. Any size AND connectivity-safe (farthest first)
   *   3. Farthest regardless (fallback for tiny maps)
   */
  function pickCandidate(
    pool: ScoredRoom[],
    alreadySealedTiles: ReadonlySet<number>,
  ): ScoredRoom | undefined {
    const meetsSize = (r: ScoredRoom): boolean => {
      const room = roomGraph.get(r.id)!;
      return room.bounds.width >= minWidth && room.bounds.height >= minHeight;
    };
    const safeCache = new Map<number, boolean>();
    const isSafe = (r: ScoredRoom): boolean => {
      if (safeCache.has(r.id)) return safeCache.get(r.id)!;
      const sealSet = buildSealSet(r.id);
      const result =
        sealSet.size === 0 && alreadySealedTiles.size === 0
          ? true
          : sealingPreservesConnectivity(sealSet, alreadySealedTiles);
      safeCache.set(r.id, result);
      return result;
    };

    for (const r of pool) {
      if (meetsSize(r) && isSafe(r)) return r;
    }
    for (const r of pool) {
      if (isSafe(r)) return r;
    }
    return pool[0]; // fallback: farthest (preserves old behaviour on tiny maps)
  }

  const bossCandidate = pickCandidate(scored, new Set<number>());
  if (bossCandidate) {
    roomGraph.setRole(bossCandidate.id, RoomRole.BOSS_STAIR);
  }

  if (roomGraph.count >= 3) {
    const remainingPool = scored.filter((r) => r.id !== bossCandidate?.id);
    const bossSealTiles = bossCandidate ? buildSealSet(bossCandidate.id) : new Set<number>();
    const safeCandidate = pickCandidate(remainingPool, bossSealTiles);
    if (safeCandidate) roomGraph.setRole(safeCandidate.id, RoomRole.SAFE);
  }
}

/**
 * Seal the perimeter of SAFE and BOSS_STAIR rooms by converting any passable
 * non-door tile on their boundary to a wall. rot-js can place corridor tiles at
 * positions that overlap the 1-tile padding of adjacent room bounds, creating
 * unintended secondary openings before variety post-processing even runs. This
 * pass guarantees the perimeter is walls + doors from the outset.
 *
 * For connectivity testing purposes, locked doors are treated as pathable — so
 * sealing the boss room here does not create unreachable areas; the room is
 * always reachable via its designated door tiles.
 */
function sealSpecialRoomPerimeters(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
): void {
  for (const room of roomGraph.getAll()) {
    if (room.role !== RoomRole.SAFE && room.role !== RoomRole.BOSS_STAIR) continue;
    const { x, y, width, height } = room.bounds;

    // Collect door tile indices so we never seal an intentional opening.
    const doorIdxSet = new Set(room.doors.map((d) => d.y * w + d.x));

    const seal = (idx: number): void => {
      if (doorIdxSet.has(idx)) return;
      const flags = tileMap.flags[idx]!;
      if ((flags & TileFlags.PASSABLE) !== 0 && (flags & TileFlags.DOOR) === 0) {
        tileMap.flags[idx] = TilePresets.WALL;
        terrain[idx] = TerrainType.STONE_WALL;
      }
    };

    for (let tx = x; tx < x + width; tx++) {
      seal(y * w + tx);
      seal((y + height - 1) * w + tx);
    }
    for (let ty = y + 1; ty < y + height - 1; ty++) {
      seal(ty * w + x);
      seal(ty * w + (x + width - 1));
    }
  }
}

/**
 * Return the set of tile indices that form the perimeter walls of SAFE and
 * BOSS_STAIR rooms. These tiles are off-limits to corridor widening and diagonal
 * shortcut carving so that special rooms remain fully walled with only their
 * door tiles as openings. No tunnel may bypass a boss room's walls or doors.
 *
 * For connectivity testing, locked doors are considered pathable — so protecting
 * these perimeters never creates unreachable areas; every special room is
 * reachable via its designated door tiles.
 */
function buildSpecialRoomWalls(roomGraph: RoomGraph, w: number): ReadonlySet<number> {
  const walls = new Set<number>();
  for (const room of roomGraph.getAll()) {
    if (room.role !== RoomRole.SAFE && room.role !== RoomRole.BOSS_STAIR) continue;
    const { x, y, width, height } = room.bounds;
    // Top and bottom rows
    for (let tx = x; tx < x + width; tx++) {
      walls.add(y * w + tx);
      walls.add((y + height - 1) * w + tx);
    }
    // Left and right columns (exclude corners already added above)
    for (let ty = y + 1; ty < y + height - 1; ty++) {
      walls.add(ty * w + x);
      walls.add(ty * w + (x + width - 1));
    }
  }
  return walls;
}

/** Repaint interior floor tiles of a room with a given terrain type. */
function paintRoomFloor(
  roomId: number,
  roomGraph: RoomGraph,
  mapWidth: number,
  terrain: Uint8Array,
  terrainType: TerrainType,
): void {
  const room = roomGraph.get(roomId);
  if (!room) return;
  const { x, y, width, height } = room.bounds;
  // Interior = 1 tile inset from bounding walls
  for (let ty = y + 1; ty < y + height - 1; ty++) {
    for (let tx = x + 1; tx < x + width - 1; tx++) {
      const idx = ty * mapWidth + tx;
      if (terrain[idx] === TerrainType.STONE_FLOOR) {
        terrain[idx] = terrainType;
      }
    }
  }
}

// ─── Room Variety Helpers ──────────────────────────────────────────────────

function getDoorSide(bounds: RoomBounds, door: DoorLocation): RoomDoorSide | null {
  if (door.x === bounds.x) return 'left';
  if (door.x === bounds.x + bounds.width - 1) return 'right';
  if (door.y === bounds.y) return 'top';
  if (door.y === bounds.y + bounds.height - 1) return 'bottom';
  return null;
}

function expandDoorsForWideCorridors(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
  widenedCorridorTiles: ReadonlySet<number>,
): void {
  const widenedCorridorTouchesDoorway = (x: number, y: number): boolean =>
    tileMap.inBounds(x, y) && widenedCorridorTiles.has(y * w + x);
  const corridorContinues = (x: number, y: number): boolean =>
    tileMap.inBounds(x, y) && terrain[y * w + x] === TerrainType.CORRIDOR;

  const carveInteriorTile = (idx: number): void => {
    if ((tileMap.flags[idx]! & TileFlags.PASSABLE) !== 0) return;
    tileMap.flags[idx] = TilePresets.FLOOR;
    terrain[idx] = TerrainType.STONE_FLOOR;
  };

  for (const room of roomGraph.getAll()) {
    if (room.role === RoomRole.NORMAL) {
      continue;
    }
    const { bounds } = room;
    const doorKeys = new Set(room.doors.map((door) => `${door.x},${door.y}`));
    const addedDoors: DoorLocation[] = [];

    const maybeAddDoor = (
      doorX: number,
      doorY: number,
      outsideX: number,
      outsideY: number,
      forwardX: number,
      forwardY: number,
      insideX: number,
      insideY: number,
    ): void => {
      const key = `${doorX},${doorY}`;
      if (
        doorKeys.has(key) ||
        !widenedCorridorTouchesDoorway(outsideX, outsideY) ||
        !corridorContinues(forwardX, forwardY)
      ) {
        return;
      }
      if (!tileMap.inBounds(doorX, doorY) || !tileMap.inBounds(insideX, insideY)) {
        return;
      }
      const isCorner =
        (doorX === bounds.x || doorX === bounds.x + bounds.width - 1) &&
        (doorY === bounds.y || doorY === bounds.y + bounds.height - 1);
      if (isCorner) {
        return;
      }
      const idx = doorY * w + doorX;
      if ((tileMap.flags[idx]! & TileFlags.DOOR) !== 0) {
        return;
      }
      carveInteriorTile(insideY * w + insideX);
      tileMap.flags[idx] = TilePresets.DOOR_CLOSED;
      terrain[idx] = TerrainType.DOOR;
      addedDoors.push({ x: doorX, y: doorY, connectsTo: -1 });
      doorKeys.add(key);
    };

    for (const door of room.doors) {
      const side = getDoorSide(room.bounds, door);
      if (side === null) continue;

      switch (side) {
        case 'left':
          maybeAddDoor(
            door.x,
            door.y - 1,
            door.x - 1,
            door.y - 1,
            door.x - 2,
            door.y - 1,
            door.x + 1,
            door.y - 1,
          );
          maybeAddDoor(
            door.x,
            door.y + 1,
            door.x - 1,
            door.y + 1,
            door.x - 2,
            door.y + 1,
            door.x + 1,
            door.y + 1,
          );
          break;
        case 'right':
          maybeAddDoor(
            door.x,
            door.y - 1,
            door.x + 1,
            door.y - 1,
            door.x + 2,
            door.y - 1,
            door.x - 1,
            door.y - 1,
          );
          maybeAddDoor(
            door.x,
            door.y + 1,
            door.x + 1,
            door.y + 1,
            door.x + 2,
            door.y + 1,
            door.x - 1,
            door.y + 1,
          );
          break;
        case 'top':
          maybeAddDoor(
            door.x - 1,
            door.y,
            door.x - 1,
            door.y - 1,
            door.x - 1,
            door.y - 2,
            door.x - 1,
            door.y + 1,
          );
          maybeAddDoor(
            door.x + 1,
            door.y,
            door.x + 1,
            door.y - 1,
            door.x + 1,
            door.y - 2,
            door.x + 1,
            door.y + 1,
          );
          break;
        case 'bottom':
          maybeAddDoor(
            door.x - 1,
            door.y,
            door.x - 1,
            door.y + 1,
            door.x - 1,
            door.y + 2,
            door.x - 1,
            door.y - 1,
          );
          maybeAddDoor(
            door.x + 1,
            door.y,
            door.x + 1,
            door.y + 1,
            door.x + 1,
            door.y + 2,
            door.x + 1,
            door.y - 1,
          );
          break;
      }
    }

    if (addedDoors.length > 0) {
      Object.assign(room, { doors: [...room.doors, ...addedDoors] });
    }
  }
}

/**
 * Apply shape variety to rooms: round (ellipse) or L-shaped.
 * Only rooms with interior size ≥ 5×5 are candidates.
 * Rooms smaller than the threshold keep their rectangular shape.
 *
 * SAFE and BOSS_STAIR rooms may receive an ellipse shape as long as the room
 * is large enough (volume check above). L-shapes are skipped for these rooms
 * because removing an entire quadrant would shrink the usable safe-room /
 * boss-fight area too aggressively; the RNG is still consumed so the sequence
 * for subsequent rooms stays identical to an unguarded run.
 */
function applyRoomShapes(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
  rng: SeededRandom,
): void {
  for (const room of roomGraph.getAll()) {
    const { x: rx, y: ry, width: rw, height: rh } = room.bounds;
    // Interior dimensions: (rw-2) × (rh-2); require at least 5×5 interior
    if (rw < 7 || rh < 7) continue;

    const roll = rng.next();

    if (roll < 0.25) {
      // Ellipses are allowed for all rooms, including special ones.
      applyEllipseShape(tileMap, terrain, w, rx, ry, rw, rh, room.doors);
    } else if (roll < 0.5) {
      if (room.role === RoomRole.SAFE || room.role === RoomRole.BOSS_STAIR) {
        // L-shapes are skipped for special rooms — consume RNG identically to keep stream intact.
        selectLShapeQuadrant(rx, ry, rw, rh, room.doors, rng);
      } else {
        applyLShape(tileMap, terrain, w, rx, ry, rw, rh, room.doors, rng);
      }
    }
    // 50% stay rectangular — also includes any oversized rooms naturally
  }
}

/**
 * Carve room interior into an ellipse, walling off tiles outside the
 * inscribed ellipse. Boundary tiles (where doors live) are untouched.
 */
function applyEllipseShape(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  doors: readonly DoorLocation[],
): void {
  // Centre of the room (may be fractional)
  const cx = rx + (rw - 1) / 2;
  const cy = ry + (rh - 1) / 2;
  // Semi-radii of the inscribed ellipse (reach to just inside the boundary)
  const ex = (rw - 2) / 2;
  const ey = (rh - 2) / 2;

  for (let ty = ry + 1; ty < ry + rh - 1; ty++) {
    for (let tx = rx + 1; tx < rx + rw - 1; tx++) {
      const dx = (tx - cx) / ex;
      const dy = (ty - cy) / ey;
      if (dx * dx + dy * dy > 1.0) {
        const idx = ty * w + tx;
        terrain[idx] = TerrainType.STONE_WALL;
        tileMap.flags[idx] = TilePresets.WALL;
      }
    }
  }

  ensureDoorAccess(tileMap, terrain, w, rx, ry, rw, rh, doors);
}

/**
 * Select the interior quadrant to remove for an L-shape.
 * Penalizes quadrants adjacent to doors; breaks ties with RNG.
 * Returns null if the room is too small for an L-shape (no RNG consumed).
 */
function selectLShapeQuadrant(
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  doors: readonly DoorLocation[],
  rng: SeededRandom,
): number | null {
  const halfW = Math.floor((rw - 2) / 2);
  const halfH = Math.floor((rh - 2) / 2);
  if (halfW < 1 || halfH < 1) return null;

  // Quadrant corners: 0=TL 1=TR 2=BL 3=BR
  // Penalize the quadrant closest to each door to avoid removing floor tiles near connectivity points.
  const quadrantScore = [0, 0, 0, 0];
  for (const door of doors) {
    const isLeft = door.x <= rx + halfW;
    const isTop = door.y <= ry + halfH;
    if (isTop && isLeft) quadrantScore[0]! += 2;
    if (isTop && !isLeft) quadrantScore[1]! += 2;
    if (!isTop && isLeft) quadrantScore[2]! += 2;
    if (!isTop && !isLeft) quadrantScore[3]! += 2;
  }

  // Pick the quadrant with the lowest door-adjacency score; break ties with rng.
  // Guard: when only one candidate exists, skip rng to avoid nextInt(0,0) ambiguity.
  const minScore = Math.min(...quadrantScore);
  const candidates = quadrantScore
    .map((s, i) => ({ s, i }))
    .filter((e) => e.s === minScore)
    .map((e) => e.i);
  return candidates.length === 1
    ? candidates[0]!
    : candidates[rng.nextInt(0, candidates.length - 1)]!;
}

/**
 * Remove one interior quadrant of the room to produce an L-shape.
 * The quadrant furthest from any door is selected to keep connectivity safe.
 * After removal, tiles immediately inside each door are guaranteed floor.
 */
function applyLShape(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  doors: readonly DoorLocation[],
  rng: SeededRandom,
): void {
  const quadrant = selectLShapeQuadrant(rx, ry, rw, rh, doors, rng);
  if (quadrant === null) return;

  // Interior bounds (exclusive)
  const ix1 = rx + 1;
  const iy1 = ry + 1;
  const ix2 = rx + rw - 1; // exclusive right edge of interior
  const iy2 = ry + rh - 1; // exclusive bottom edge of interior
  const halfW = Math.floor((rw - 2) / 2);
  const halfH = Math.floor((rh - 2) / 2);

  // Determine the tile range to fill for the chosen quadrant
  let qx1: number, qy1: number, qx2: number, qy2: number;
  switch (quadrant) {
    case 0:
      qx1 = ix1;
      qy1 = iy1;
      qx2 = ix1 + halfW;
      qy2 = iy1 + halfH;
      break; // TL
    case 1:
      qx1 = ix1 + halfW;
      qy1 = iy1;
      qx2 = ix2;
      qy2 = iy1 + halfH;
      break; // TR
    case 2:
      qx1 = ix1;
      qy1 = iy1 + halfH;
      qx2 = ix1 + halfW;
      qy2 = iy2;
      break; // BL
    default:
      qx1 = ix1 + halfW;
      qy1 = iy1 + halfH;
      qx2 = ix2;
      qy2 = iy2;
      break; // BR
  }

  for (let ty = qy1; ty < qy2; ty++) {
    for (let tx = qx1; tx < qx2; tx++) {
      const idx = ty * w + tx;
      terrain[idx] = TerrainType.STONE_WALL;
      tileMap.flags[idx] = TilePresets.WALL;
    }
  }

  // Ensure every door still has a reachable interior tile on its inner side
  ensureDoorAccess(tileMap, terrain, w, rx, ry, rw, rh, doors);
}

/**
 * For each door, guarantee the immediately adjacent interior tile is passable.
 * This repairs any case where room reshaping accidentally blocked a doorway.
 */
function ensureDoorAccess(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  doors: readonly DoorLocation[],
): void {
  for (const door of doors) {
    for (const [nx, ny] of [
      [door.x - 1, door.y],
      [door.x + 1, door.y],
      [door.x, door.y - 1],
      [door.x, door.y + 1],
    ] as [number, number][]) {
      // Must be strictly inside the room bounds (interior tile)
      if (nx > rx && nx < rx + rw - 1 && ny > ry && ny < ry + rh - 1) {
        const idx = ny * w + nx;
        if ((tileMap.flags[idx]! & TileFlags.PASSABLE) === 0) {
          terrain[idx] = TerrainType.STONE_FLOOR;
          tileMap.flags[idx] = TilePresets.FLOOR;
        }
      }
    }
  }
}

/**
 * Remove door markers that no longer have any passable interior-adjacent tile.
 * This can happen after reachability culling seals isolated room interiors.
 */
function pruneInaccessibleDoors(
  roomGraph: RoomGraph,
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
): void {
  for (const room of roomGraph.getAll()) {
    const keptDoors: DoorLocation[] = [];
    for (const door of room.doors) {
      const side = getDoorSide(room.bounds, door);
      const inward: [number, number] =
        side === 'left'
          ? [door.x + 1, door.y]
          : side === 'right'
            ? [door.x - 1, door.y]
            : side === 'top'
              ? [door.x, door.y + 1]
              : [door.x, door.y - 1];
      const [ix, iy] = inward;
      const hasInteriorAccess =
        ix > room.bounds.x &&
        ix < room.bounds.x + room.bounds.width - 1 &&
        iy > room.bounds.y &&
        iy < room.bounds.y + room.bounds.height - 1 &&
        tileMap.isPassable(ix, iy);
      if (hasInteriorAccess) {
        keptDoors.push(door);
        continue;
      }
      const idx = door.y * w + door.x;
      tileMap.flags[idx] = TilePresets.WALL;
      terrain[idx] = TerrainType.STONE_WALL;
    }
    Object.assign(room, { doors: keptDoors });
  }
}

/**
 * Widen corridors by one tile perpendicular to their primary direction.
 * Horizontal corridors (neighboured E/W by floor) get a north or south tile added;
 * vertical corridors get an east or west tile added. Uses a two-pass approach
 * to avoid cascading widening from a single pass.
 * ~85% of corridor tiles are widened to keep hallways broadly wide.
 */
function widenCorridors(
  tileMap: TileMap,
  terrain: Uint8Array,
  w: number,
  h: number,
  rng: SeededRandom,
  protectedWalls: ReadonlySet<number>,
): ReadonlySet<number> {
  const toWiden = new Set<number>();

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (terrain[idx] !== TerrainType.CORRIDOR) continue;
      if (rng.next() > 0.85) continue; // only widen ~85% of corridor tiles

      const tN = terrain[(y - 1) * w + x]!;
      const tS = terrain[(y + 1) * w + x]!;
      const tE = terrain[y * w + (x + 1)]!;
      const tW = terrain[y * w + (x - 1)]!;

      const floorOrCorridor = (t: number): boolean =>
        t === TerrainType.CORRIDOR ||
        t === TerrainType.STONE_FLOOR ||
        t === TerrainType.DOOR ||
        t === TerrainType.SAFE_ROOM_FLOOR ||
        t === TerrainType.BOSS_STAIR_FLOOR;

      const hasNS = floorOrCorridor(tN) || floorOrCorridor(tS);
      const hasEW = floorOrCorridor(tE) || floorOrCorridor(tW);

      if (hasNS && !hasEW) {
        // Vertical corridor — try to expand east
        const targetIdx = y * w + (x + 1);
        if (
          x + 1 < w - 1 &&
          terrain[targetIdx] === TerrainType.STONE_WALL &&
          !protectedWalls.has(targetIdx)
        ) {
          toWiden.add(targetIdx);
        }
      } else if (hasEW && !hasNS) {
        // Horizontal corridor — try to expand south
        const targetIdx = (y + 1) * w + x;
        if (
          y + 1 < h - 1 &&
          terrain[targetIdx] === TerrainType.STONE_WALL &&
          !protectedWalls.has(targetIdx)
        ) {
          toWiden.add(targetIdx);
        }
      }
    }
  }

  for (const idx of toWiden) {
    terrain[idx] = TerrainType.CORRIDOR;
    tileMap.flags[idx] = TilePresets.FLOOR;
  }
  return toWiden;
}

/**
 * Add diagonal shortcut corridors between rooms that are positioned diagonally
 * and not yet directly connected. Uses Bresenham's line algorithm to carve a
 * staircase-style diagonal path. Only wall tiles are overwritten; existing
 * floor/corridor/door tiles are preserved.
 */
function addDiagonalShortcuts(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
  h: number,
  rng: SeededRandom,
  protectedWalls: ReadonlySet<number>,
): void {
  const rooms = roomGraph.getAll();
  const connected = new Set<string>();

  for (let i = 0; i < rooms.length; i++) {
    if (rng.next() >= 0.2) continue; // attempt a diagonal shortcut for ~20% of rooms

    const a = rooms[i]!;
    const cxA = Math.floor(a.bounds.x + a.bounds.width / 2);
    const cyA = Math.floor(a.bounds.y + a.bounds.height / 2);

    let bestDist = Infinity;
    let bestJ = -1;

    for (let j = 0; j < rooms.length; j++) {
      if (j === i) continue;
      const key = `${Math.min(i, j)}:${Math.max(i, j)}`;
      if (connected.has(key)) continue;

      const b = rooms[j]!;
      const cxB = Math.floor(b.bounds.x + b.bounds.width / 2);
      const cyB = Math.floor(b.bounds.y + b.bounds.height / 2);
      const dx = Math.abs(cxB - cxA);
      const dy = Math.abs(cyB - cyA);

      // Both components must be significant (truly diagonal)
      if (dx < 10 || dy < 10) continue;
      // Not too far to be a useful shortcut
      const dist = dx + dy; // Manhattan, fast
      if (dist > 45) continue;
      // Diagonal ratio: neither axis should dominate more than ~3:1
      if (dx > dy * 3 || dy > dx * 3) continue;

      if (dist < bestDist) {
        bestDist = dist;
        bestJ = j;
      }
    }

    if (bestJ >= 0) {
      const b = rooms[bestJ]!;
      const cxB = Math.floor(b.bounds.x + b.bounds.width / 2);
      const cyB = Math.floor(b.bounds.y + b.bounds.height / 2);
      carveBresenhamPath(tileMap, terrain, cxA, cyA, cxB, cyB, w, h, protectedWalls);
      connected.add(`${Math.min(i, bestJ)}:${Math.max(i, bestJ)}`);
    }
  }
}

/**
 * Carve a Bresenham-line path from (x0,y0) to (x1,y1), converting STONE_WALL
 * tiles to CORRIDOR. Existing floor/door tiles are left unchanged.
 * Each step also widens the path by one tile perpendicular to the major axis
 * so the diagonal corridor is 2 tiles wide and freely navigable.
 */
function carveBresenhamPath(
  tileMap: TileMap,
  terrain: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  h: number,
  protectedWalls: ReadonlySet<number>,
): void {
  const carve = (x: number, y: number): void => {
    if (x <= 0 || x >= w - 1 || y <= 0 || y >= h - 1) return;
    const idx = y * w + x;
    if (protectedWalls.has(idx)) return; // never breach special room perimeters
    if (terrain[idx] === TerrainType.STONE_WALL) {
      terrain[idx] = TerrainType.CORRIDOR;
      tileMap.flags[idx] = TilePresets.FLOOR;
    }
  };

  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    carve(x, y);
    // Widen by one tile in a fixed perpendicular direction so the corridor is
    // consistently 2 tiles wide regardless of path direction.
    if (dx >= dy) {
      carve(x, y + 1); // horizontal-dominant: always expand south
    } else {
      carve(x + 1, y); // vertical-dominant: always expand east
    }

    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

function buildCaveProtectedMask(roomGraph: RoomGraph, w: number, h: number): Uint8Array {
  const blocked = new Uint8Array(w * h);
  for (const room of roomGraph.getAll()) {
    if (room.role !== RoomRole.SAFE && room.role !== RoomRole.BOSS_STAIR) continue;
    const { x, y, width, height } = room.bounds;
    for (let ty = Math.max(0, y - 1); ty < Math.min(h, y + height + 1); ty++) {
      for (let tx = Math.max(0, x - 1); tx < Math.min(w, x + width + 1); tx++) {
        blocked[ty * w + tx] = 1;
      }
    }
  }
  return blocked;
}

function carveCaveRegions(
  tileMap: TileMap,
  terrain: Uint8Array,
  roomGraph: RoomGraph,
  w: number,
  h: number,
  blocked: Uint8Array,
  seed: number,
): void {
  let caveState = (seed ^ 0x9e3779b9 ^ (w << 8) ^ h) >>> 0;
  const caveRand = (): number => {
    caveState = (Math.imul(caveState, 1664525) + 1013904223) >>> 0;
    return caveState / 0x100000000;
  };
  const caveRandInt = (min: number, max: number): number =>
    min + Math.floor(caveRand() * (max - min + 1));

  const candidates: number[] = [];
  const inBounds = (x: number, y: number): boolean => x > 1 && x < w - 2 && y > 1 && y < h - 2;

  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const idx = y * w + x;
      if (blocked[idx]) continue;
      if ((tileMap.flags[idx]! & TileFlags.DOOR) !== 0) continue;
      if (terrain[idx] !== TerrainType.STONE_FLOOR) continue;
      const roomId = roomGraph.getRoomAt(x, y);
      if (roomId !== -1) {
        const room = roomGraph.get(roomId);
        if (!room || room.role !== RoomRole.NORMAL) continue;
      }
      candidates.push(idx);
    }
  }

  if (candidates.length === 0) return;

  const regionCount = Math.max(2, Math.min(8, Math.floor((w * h) / 5000)));

  const carveTile = (x: number, y: number): void => {
    if (!inBounds(x, y)) return;
    const idx = y * w + x;
    if (blocked[idx]) return;
    const flags = tileMap.flags[idx]!;
    if ((flags & TileFlags.DOOR) !== 0) return;
    if ((flags & TileFlags.PASSABLE) === 0) return;
    terrain[idx] = TerrainType.CAVE_FLOOR;
  };

  const carveOrganicPatch = (cx: number, cy: number, rx: number, ry: number): void => {
    for (let y = cy - ry; y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        if (!inBounds(x, y)) continue;
        const nx = rx <= 0 ? 0 : (x - cx) / rx;
        const ny = ry <= 0 ? 0 : (y - cy) / ry;
        const jitter = (caveRand() - 0.5) * 0.35;
        if (nx * nx + ny * ny <= 1 + jitter) {
          carveTile(x, y);
        }
      }
    }
  };

  for (let i = 0; i < regionCount; i++) {
    const start = candidates[caveRandInt(0, candidates.length - 1)]!;
    let x = start % w;
    let y = (start - x) / w;
    let angle = caveRand() * Math.PI * 2;
    let curvature = (caveRand() - 0.5) * 0.8;
    const steps = caveRandInt(22, 64);

    for (let step = 0; step < steps; step++) {
      carveOrganicPatch(x, y, caveRandInt(1, 2), caveRandInt(1, 2));

      if (caveRand() < 0.18) {
        carveOrganicPatch(x, y, caveRandInt(3, 6), caveRandInt(2, 5));
      }

      curvature = curvature * 0.72 + (caveRand() - 0.5) * 0.35;
      angle += curvature;
      x = Math.round(x + Math.cos(angle));
      y = Math.round(y + Math.sin(angle));

      if (!inBounds(x, y) || blocked[y * w + x]) {
        angle += Math.PI * (0.6 + caveRand() * 0.8);
        x = Math.min(w - 3, Math.max(2, x));
        y = Math.min(h - 3, Math.max(2, y));
      }
    }
  }

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (terrain[idx] !== TerrainType.CAVE_FLOOR) continue;
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ] as const) {
        const nIdx = ny * w + nx;
        if (blocked[nIdx]) continue;
        if (terrain[nIdx] === TerrainType.STONE_WALL) {
          terrain[nIdx] = TerrainType.CAVE_WALL;
        }
      }
    }
  }
}
