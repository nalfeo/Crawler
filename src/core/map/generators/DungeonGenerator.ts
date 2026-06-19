/**
 * DungeonGenerator — room-based dungeon layout using rot-js.
 *
 * Produces rooms connected by corridors with automatic door placement.
 * Best for: castle, dungeon, and structured interior biomes.
 */

import { Map as ROTMap, RNG } from 'rot-js';
import type { MapConfig, DoorLocation, RoomBounds } from '../../../shared/map-types';
import { TilePresets, TerrainType, RoomRole } from '../../../shared/map-types';
import type { SeededRandom } from '../../../shared/random';
import { TileMap } from '../TileMap';
import { RoomGraph } from '../RoomGraph';
import { FloorMap } from '../FloorMap';
import type { MapGenerator } from './types';

export class DungeonGenerator implements MapGenerator {
  readonly name = 'DungeonGenerator';

  generate(config: MapConfig, _rng: SeededRandom): FloorMap {
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

    // --- Derive room adjacency from real walkable connectivity ---
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

    // Room 0 is spawn. Score remaining rooms by distance from spawn center;
    // furthest → BOSS_STAIR, second-furthest → SAFE, rest → NORMAL.
    const spawnRoom = roomGraph.get(0);
    let playerSpawn = { x: Math.floor(w / 2), y: Math.floor(h / 2) };
    if (spawnRoom) {
      playerSpawn = {
        x: Math.floor(spawnRoom.bounds.x + spawnRoom.bounds.width / 2),
        y: Math.floor(spawnRoom.bounds.y + spawnRoom.bounds.height / 2),
      };
      roomGraph.setRole(0, RoomRole.SPAWN);
    }

    if (roomGraph.count >= 2) {
      const scored = roomGraph
        .getAll()
        .filter((r) => r.id !== 0)
        .map((room) => {
          const cx = Math.floor(room.bounds.x + room.bounds.width / 2);
          const cy = Math.floor(room.bounds.y + room.bounds.height / 2);
          const dx = cx - playerSpawn.x;
          const dy = cy - playerSpawn.y;
          return { id: room.id, distanceSq: dx * dx + dy * dy };
        });
      scored.sort((a, b) => b.distanceSq - a.distanceSq);

      const bossStairId = scored[0]?.id;
      const safeId = scored[1]?.id;

      if (bossStairId !== undefined) {
        roomGraph.setRole(bossStairId, RoomRole.BOSS_STAIR);
        paintRoomFloor(bossStairId, roomGraph, w, terrain, TerrainType.BOSS_STAIR_FLOOR);
      }
      if (safeId !== undefined) {
        roomGraph.setRole(safeId, RoomRole.SAFE);
        paintRoomFloor(safeId, roomGraph, w, terrain, TerrainType.SAFE_ROOM_FLOOR);
      }
    }

    return new FloorMap(config, tileMap, roomGraph, terrain, playerSpawn);
  }
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
