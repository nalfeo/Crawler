/**
 * ArenaGenerator — simple bounded arena with obstacle scatter.
 *
 * Produces a rectangular playfield enclosed by walls, with random
 * obstacles (pillars, walls) scattered throughout.
 *
 * Best for: boss arenas, tutorial floors, fallback.
 */

import type { MapConfig } from '../../../shared/map-types';
import { TilePresets, TerrainType } from '../../../shared/map-types';
import type { SeededRandom } from '../../../shared/random';
import { TileMap } from '../TileMap';
import { RoomGraph } from '../RoomGraph';
import { FloorMap } from '../FloorMap';
import type { MapGenerator } from './types';

export interface ArenaOptions {
  /** Number of random obstacle clusters to place. Default: 20 */
  obstacleCount?: number;
  /** Max size of each obstacle cluster in tiles. Default: 5 */
  maxObstacleSize?: number;
  /** Border wall thickness in tiles. Default: 2 */
  borderThickness?: number;
}

const DEFAULT_ARENA_OPTIONS: Required<ArenaOptions> = {
  obstacleCount: 20,
  maxObstacleSize: 5,
  borderThickness: 2,
};

export class ArenaGenerator implements MapGenerator {
  readonly name = 'ArenaGenerator';
  private readonly options: Required<ArenaOptions>;

  constructor(options: ArenaOptions = {}) {
    this.options = { ...DEFAULT_ARENA_OPTIONS, ...options };
  }

  generate(config: MapConfig, rng: SeededRandom): FloorMap {
    const { widthTiles: w, heightTiles: h } = config;
    const border = this.options.borderThickness;

    const tileMap = new TileMap(w, h);
    const terrain = new Uint8Array(w * h);
    const roomGraph = new RoomGraph();

    // Fill everything with walls first
    tileMap.fill(TilePresets.WALL);
    terrain.fill(TerrainType.STONE_WALL);

    // Carve out the interior
    tileMap.fillRect(border, border, w - border * 2, h - border * 2, TilePresets.FLOOR);
    for (let y = border; y < h - border; y++) {
      for (let x = border; x < w - border; x++) {
        terrain[y * w + x] = TerrainType.STONE_FLOOR;
      }
    }

    // Add the arena as a single room
    roomGraph.add({
      x: border,
      y: border,
      width: w - border * 2,
      height: h - border * 2,
    });

    // Scatter obstacles — avoid center spawn area
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    const safeRadius = 8; // tiles around spawn that stay clear

    for (let i = 0; i < this.options.obstacleCount; i++) {
      const ow = rng.nextInt(1, this.options.maxObstacleSize);
      const oh = rng.nextInt(1, this.options.maxObstacleSize);
      const ox = rng.nextInt(border + 2, w - border - 2 - ow);
      const oy = rng.nextInt(border + 2, h - border - 2 - oh);

      // Skip if too close to center spawn
      const distX = Math.abs(ox + ow / 2 - cx);
      const distY = Math.abs(oy + oh / 2 - cy);
      if (distX < safeRadius && distY < safeRadius) continue;

      tileMap.fillRect(ox, oy, ow, oh, TilePresets.WALL);
      for (let y = oy; y < oy + oh; y++) {
        for (let x = ox; x < ox + ow; x++) {
          if (x >= 0 && x < w && y >= 0 && y < h) {
            terrain[y * w + x] = TerrainType.STONE_WALL;
          }
        }
      }
    }

    return new FloorMap(config, tileMap, roomGraph, terrain, { x: cx, y: cy });
  }
}
