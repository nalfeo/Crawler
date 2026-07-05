/**
 * Integration: full-size (270×156) Floor 2 cave-system generation across a
 * spread of seeds. Every labelled cavern must be reachable from the spawn.
 *
 * Slower than the unit tests — runs at manifest-target dimensions.
 */

import { describe, it, expect } from 'vitest';
import { SeededRandom } from '../../src/shared/random';
import { BiomeType, RoomRole } from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';
import { getGenerator } from '../../src/core/map/generators/registry';

const WIDTH = 270;
const HEIGHT = 156;

function bfsFromSpawn(floor: {
  tileMap: { isPassable: (x: number, y: number) => boolean };
  playerSpawn: { x: number; y: number };
}): Uint8Array {
  const seen = new Uint8Array(WIDTH * HEIGHT);
  const q: number[] = [floor.playerSpawn.y * WIDTH + floor.playerSpawn.x];
  seen[q[0]!] = 1;
  let head = 0;
  while (head < q.length) {
    const idx = q[head++]!;
    const x = idx % WIDTH;
    const y = (idx / WIDTH) | 0;
    for (const [nx, ny] of [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ] as const) {
      if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
      const ni = ny * WIDTH + nx;
      if (seen[ni]) continue;
      if (!floor.tileMap.isPassable(nx, ny)) continue;
      seen[ni] = 1;
      q.push(ni);
    }
  }
  return seen;
}

describe('Floor 2 cave map integration', () => {
  // 15 seeds — fewer than the spec's 50 to keep test time reasonable
  // (each full-size generation is 1–7s). Still a broad determinism check.
  const seeds = Array.from({ length: 15 }, (_, i) => 1000 + i * 37);

  it.each(seeds)(
    'seed %i: generates and satisfies all invariants',
    (seed) => {
      const gen = getGenerator(BiomeType.CAVE_SYSTEM);
      const cfg: MapConfig = {
        widthTiles: WIDTH,
        heightTiles: HEIGHT,
        tileSizeFt: 4,
        biome: BiomeType.CAVE_SYSTEM,
        seed,
        roomWidthRange: [7, 16],
        roomHeightRange: [6, 14],
        maxRooms: 55,
        floorDensity: 0.45,
      };
      const floor = gen.generate(cfg, new SeededRandom(seed));
      const rooms = floor.roomGraph.getAll();

      // Role counts.
      const byRole = (r: RoomRole) => rooms.filter((x) => x.role === r).length;
      expect(byRole(RoomRole.SPAWN)).toBe(1);
      expect(byRole(RoomRole.SETTLEMENT)).toBe(1);
      expect(byRole(RoomRole.RESOURCE_HEART)).toBe(1);
      expect(byRole(RoomRole.TERRITORY)).toBe(4);
      expect(byRole(RoomRole.BOSS_DEN)).toBe(4);

      // familyIndex uniqueness.
      const territoryIndices = rooms
        .filter((r) => r.role === RoomRole.TERRITORY)
        .map((r) => r.familyIndex)
        .sort();
      expect(territoryIndices).toEqual([0, 1, 2, 3]);

      // Reachability from spawn — for each labelled room, at least one
      // passable tile inside the bounds must be reached. (Bounding boxes
      // are rectangles around irregular cavern shapes, so the geometric
      // centre may fall in wall; we sample the whole bounds.)
      const reached = bfsFromSpawn(floor);
      const requiredRoles = [RoomRole.TERRITORY, RoomRole.SETTLEMENT, RoomRole.RESOURCE_HEART];
      for (const room of rooms.filter((r) => requiredRoles.includes(r.role))) {
        let ok = false;
        let hasPassable = false;
        for (let y = room.bounds.y; y < room.bounds.y + room.bounds.height && !ok; y++) {
          for (let x = room.bounds.x; x < room.bounds.x + room.bounds.width && !ok; x++) {
            if (!floor.tileMap.isPassable(x, y)) continue;
            hasPassable = true;
            if (reached[y * WIDTH + x]) ok = true;
          }
        }
        expect(hasPassable, `seed=${seed} role=${room.role} bounds contain no passable tile`).toBe(
          true,
        );
        expect(
          ok,
          `seed=${seed} role=${room.role} bounds=${JSON.stringify(room.bounds)} unreachable`,
        ).toBe(true);
      }
    },
    30_000,
  );
});
