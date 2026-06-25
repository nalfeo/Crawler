/**
 * CaveGenerator — organic cave layouts using rot-js cellular automata.
 *
 * Produces connected cave networks without discrete rooms.
 * Uses cellular automata with configurable birth/survival rules,
 * then connects disconnected regions.
 *
 * Best for: cave systems, natural formations, fire swamp.
 */

import { Map as ROTMap, RNG } from 'rot-js';
import type { MapConfig } from '../../../shared/map-types';
import { TilePresets, TerrainType } from '../../../shared/map-types';
import type { SeededRandom } from '../../../shared/random';
import { TileMap } from '../TileMap';
import { RoomGraph } from '../RoomGraph';
import { FloorMap } from '../FloorMap';
import type { MapGenerator } from './types';

export interface CaveOptions {
  /** Initial fill probability (0-1). Higher = more walls. Default: 0.5 */
  initialFill?: number;
  /** Number of smoothing passes. More = smoother caves. Default: 4 */
  smoothingPasses?: number;
  /** Cells born with this many neighbors. Default: [5,6,7,8] */
  born?: number[];
  /** Cells survive with this many neighbors. Default: [4,5,6,7,8] */
  survive?: number[];
}

const DEFAULT_CAVE_OPTIONS: Required<CaveOptions> = {
  initialFill: 0.57,
  smoothingPasses: 6,
  born: [5, 6, 7, 8],
  survive: [5, 6, 7, 8],
};

export class CaveGenerator implements MapGenerator {
  readonly name = 'CaveGenerator';
  private readonly options: Required<CaveOptions>;

  constructor(options: CaveOptions = {}) {
    this.options = { ...DEFAULT_CAVE_OPTIONS, ...options };
  }

  generate(config: MapConfig, _rng: SeededRandom): FloorMap {
    const { widthTiles: w, heightTiles: h } = config;

    const tileMap = new TileMap(w, h);
    const terrain = new Uint8Array(w * h);
    const roomGraph = new RoomGraph(); // caves have no discrete rooms

    // Seed rot-js's internal RNG for deterministic generation
    RNG.setSeed(config.seed);

    const cellular = new ROTMap.Cellular(w, h, {
      born: this.options.born,
      survive: this.options.survive,
      topology: 8,
    });

    // Initial random fill
    cellular.randomize(this.options.initialFill);

    // Smoothing passes
    for (let i = 0; i < this.options.smoothingPasses; i++) {
      cellular.create();
    }

    // Final pass with connect — ensures all cave regions are linked
    cellular.connect(
      (x: number, y: number, value: number) => {
        const idx = y * w + x;
        if (value === 1) {
          tileMap.flags[idx] = TilePresets.FLOOR;
          terrain[idx] = TerrainType.CAVE_FLOOR;
        } else {
          tileMap.flags[idx] = TilePresets.WALL;
          terrain[idx] = TerrainType.CAVE_WALL;
        }
      },
      1, // connect floors (value=1)
    );

    // Ensure border walls
    for (let x = 0; x < w; x++) {
      tileMap.flags[x] = TilePresets.WALL;
      terrain[x] = TerrainType.CAVE_WALL;
      tileMap.flags[(h - 1) * w + x] = TilePresets.WALL;
      terrain[(h - 1) * w + x] = TerrainType.CAVE_WALL;
    }
    for (let y = 0; y < h; y++) {
      tileMap.flags[y * w] = TilePresets.WALL;
      terrain[y * w] = TerrainType.CAVE_WALL;
      tileMap.flags[y * w + (w - 1)] = TilePresets.WALL;
      terrain[y * w + (w - 1)] = TerrainType.CAVE_WALL;
    }

    // Find player spawn — first passable tile near center
    const playerSpawn = this.findSpawnNearCenter(tileMap, w, h);

    return new FloorMap(config, tileMap, roomGraph, terrain, playerSpawn);
  }

  private findSpawnNearCenter(tileMap: TileMap, w: number, h: number): { x: number; y: number } {
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);

    // Spiral outward from center until we find a passable tile
    for (let radius = 0; radius < Math.max(w, h); radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (tileMap.isPassable(x, y)) {
            return { x, y };
          }
        }
      }
    }

    return { x: cx, y: cy }; // fallback
  }
}
