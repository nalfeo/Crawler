/**
 * DungeonGenerator — room-based dungeon layout using rot-js.
 *
 * Produces rooms connected by corridors with automatic door placement.
 * Best for: castle, dungeon, and structured interior biomes.
 */

import { Map as ROTMap, RNG } from 'rot-js';
import type { MapConfig, DoorLocation, RoomBounds } from '../../../shared/map-types';
import { TilePresets, TerrainType } from '../../../shared/map-types';
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

    // Tracks rot-js room data extracted during generation
    let rotRooms: ReturnType<InstanceType<typeof ROTMap.Uniform>['getRooms']> = [];

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

    rotRooms = rotMap.getRooms();

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

    // Extract doors from rot-js rooms and place them
    for (let i = 0; i < rotRooms.length; i++) {
      const rotRoom = rotRooms[i]!;
      const roomId = roomIndexMap.get(i)!;
      const room = roomGraph.get(roomId)!;
      const doors: DoorLocation[] = [];

      rotRoom.getDoors((x: number, y: number) => {
        const idx = y * w + x;
        tileMap.flags[idx] = TilePresets.DOOR_CLOSED;
        terrain[idx] = TerrainType.DOOR;

        // Find which other room this door connects to
        let connectsTo = -1;
        for (let j = 0; j < rotRooms.length; j++) {
          if (j === i) continue;
          const other = rotRooms[j]!;
          // Check if door is adjacent to other room
          if (
            x >= other.getLeft() - 1 &&
            x <= other.getRight() + 1 &&
            y >= other.getTop() - 1 &&
            y <= other.getBottom() + 1
          ) {
            connectsTo = roomIndexMap.get(j) ?? -1;
            break;
          }
        }

        doors.push({ x, y, connectsTo });
      });

      // Update room with doors and neighbors
      const neighbors = doors.map((d) => d.connectsTo).filter((n) => n !== -1);
      const updatedRoom = { ...room, doors, neighbors };
      // Overwrite in the graph (add returns sequential IDs)
      Object.assign(roomGraph.get(roomId)!, updatedRoom);
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

    // Player spawns in the first room's center
    const spawnRoom = roomGraph.get(0);
    let playerSpawn = { x: Math.floor(w / 2), y: Math.floor(h / 2) };
    if (spawnRoom) {
      playerSpawn = {
        x: Math.floor(spawnRoom.bounds.x + spawnRoom.bounds.width / 2),
        y: Math.floor(spawnRoom.bounds.y + spawnRoom.bounds.height / 2),
      };
    }

    return new FloorMap(config, tileMap, roomGraph, terrain, playerSpawn);
  }
}
