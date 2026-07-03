/**
 * Property tests: fast-check invariants over a bounded seed range.
 * Uses small maps to stay under vitest timeout.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SeededRandom } from '../../src/shared/random';
import { BiomeType, RoomRole } from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';
import { CaveSystemGenerator } from '../../src/core/map/generators/cave-system';

function cfg(seed: number): MapConfig {
  return {
    widthTiles: 70,
    heightTiles: 50,
    tileSizeFt: 4,
    biome: BiomeType.CAVE_SYSTEM,
    seed,
    roomWidthRange: [5, 12],
    roomHeightRange: [5, 12],
    maxRooms: 20,
    floorDensity: 0.45,
  };
}

describe('CaveSystemGenerator properties', () => {
  it('for every seed: role counts and familyIndex uniqueness hold', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 3, max: 4 }),
        (seed, presentCount) => {
          const gen = new CaveSystemGenerator({ presentCount });
          const floor = gen.generate(cfg(seed), new SeededRandom(seed));
          const rooms = floor.roomGraph.getAll();
          const byRole = (r: RoomRole) => rooms.filter((x) => x.role === r).length;
          expect(byRole(RoomRole.SPAWN)).toBe(1);
          expect(byRole(RoomRole.SETTLEMENT)).toBe(1);
          expect(byRole(RoomRole.RESOURCE_HEART)).toBe(1);
          expect(byRole(RoomRole.TERRITORY)).toBe(presentCount);
          expect(byRole(RoomRole.BOSS_DEN)).toBe(presentCount);
          const idx = rooms
            .filter((r) => r.role === RoomRole.TERRITORY)
            .map((r) => r.familyIndex)
            .sort();
          expect(idx).toEqual(Array.from({ length: presentCount }, (_, i) => i));
        },
      ),
      { numRuns: 12, seed: 42 },
    );
  }, 60_000);

  it('for every seed: identical output for the same input', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (seed) => {
        const g1 = new CaveSystemGenerator({ presentCount: 4 });
        const g2 = new CaveSystemGenerator({ presentCount: 4 });
        const a = g1.generate(cfg(seed), new SeededRandom(seed));
        const b = g2.generate(cfg(seed), new SeededRandom(seed));
        expect(a.playerSpawn).toEqual(b.playerSpawn);
        expect(a.tileMap.flags).toEqual(b.tileMap.flags);
      }),
      { numRuns: 8, seed: 42 },
    );
  }, 60_000);
});
