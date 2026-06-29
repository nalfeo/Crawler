/**
 * Golden-map determinism guard for DungeonGenerator.
 *
 * Snapshots the full FloorMap output of `DungeonGenerator.generate()` across a
 * fixed matrix of configs (flat, room-variety, cave-regions) and seeds 1..10.
 * The serialized form captures every observable byte of generation:
 *   - terrain bytes (FNV-1a hash)
 *   - tile physics flags (FNV-1a hash)
 *   - player spawn tile
 *   - every room's bounds, role, doors (x,y -> connectsTo), and neighbors
 *
 * This snapshot was captured from the monolithic DungeonGenerator.ts BEFORE it
 * was decomposed into the `dungeon/` modules. After the split, the SAME maps
 * must serialize byte-identically — this is the proof of zero behavior change.
 *
 * If this test fails after a refactor, the extraction changed generation output.
 * Fix the extraction — do NOT update the snapshot, tune gameplay, or cherry-pick
 * seeds. Determinism uses SeededRandom + rot-js's seeded RNG only.
 */

import { describe, it, expect } from 'vitest';
import { BiomeType } from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';
import { SeededRandom } from '../../src/shared/random';
import { DungeonGenerator } from '../../src/core/map/generators/DungeonGenerator';
import type { FloorMap } from '../../src/core/map/FloorMap';

/** FNV-1a 32-bit hash over a byte array — stable, dependency-free. */
function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Deterministically serialize a generated floor into a compact golden record. */
function serializeFloor(floor: FloorMap): Record<string, unknown> {
  return {
    width: floor.width,
    height: floor.height,
    spawn: `${floor.playerSpawn.x},${floor.playerSpawn.y}`,
    terrainHash: hashBytes(floor.terrain),
    flagsHash: hashBytes(floor.tileMap.flags),
    rooms: floor.rooms.map((room) => ({
      id: room.id,
      role: room.role,
      bounds: `${room.bounds.x},${room.bounds.y},${room.bounds.width},${room.bounds.height}`,
      doors: room.doors.map((door) => `${door.x},${door.y}->${door.connectsTo}`),
      neighbors: [...room.neighbors],
    })),
  };
}

interface ConfigVariant {
  readonly name: string;
  readonly makeGenerator: () => DungeonGenerator;
  readonly base: Omit<MapConfig, 'seed'>;
}

/** Flat dungeon — small rooms, no variety. Exercises the core pipeline. */
const FLAT_BASE: Omit<MapConfig, 'seed'> = {
  widthTiles: 60,
  heightTiles: 40,
  tileSizeFt: 4,
  biome: BiomeType.DUNGEON,
  roomWidthRange: [4, 8],
  roomHeightRange: [4, 8],
  maxRooms: 10,
  floorDensity: 0.3,
};

/** Larger rooms so special-room sizing and shape variety paths are exercised. */
const VARIETY_BASE: Omit<MapConfig, 'seed'> = {
  widthTiles: 80,
  heightTiles: 60,
  tileSizeFt: 4,
  biome: BiomeType.BASIC_UNDERGROUND,
  roomWidthRange: [9, 14],
  roomHeightRange: [9, 13],
  maxRooms: 12,
  floorDensity: 0.35,
};

const VARIANTS: readonly ConfigVariant[] = [
  { name: 'flat', makeGenerator: () => new DungeonGenerator(), base: FLAT_BASE },
  {
    name: 'variety',
    makeGenerator: () => new DungeonGenerator({ roomVariety: true }),
    base: VARIETY_BASE,
  },
  {
    name: 'caves',
    makeGenerator: () => new DungeonGenerator({ roomVariety: true, caveRegions: true }),
    base: VARIETY_BASE,
  },
];

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

describe('DungeonGenerator golden-map determinism', () => {
  it('produces byte-identical FloorMaps across the config/seed matrix', () => {
    const golden: Record<string, unknown> = {};
    for (const variant of VARIANTS) {
      for (const seed of SEEDS) {
        const config: MapConfig = { ...variant.base, seed };
        const floor = variant.makeGenerator().generate(config, new SeededRandom(seed));
        golden[`${variant.name}#${seed}`] = serializeFloor(floor);
      }
    }
    expect(golden).toMatchSnapshot();
  });

  it('is stable across repeated generation with the same seed', () => {
    for (const variant of VARIANTS) {
      const config: MapConfig = { ...variant.base, seed: 7 };
      const first = serializeFloor(variant.makeGenerator().generate(config, new SeededRandom(7)));
      const second = serializeFloor(variant.makeGenerator().generate(config, new SeededRandom(7)));
      expect(second).toEqual(first);
    }
  });
});
