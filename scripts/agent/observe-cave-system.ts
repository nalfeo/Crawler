/**
 * Smoke: exercises the CaveSystemGenerator via the biome registry lookup
 * (Rule #10 real-pipeline observation). Prints per-seed stats.
 *
 * Run via `npx tsx scripts/agent/observe-cave-system.ts`.
 */

import { BiomeType } from '../../src/shared/map-types';
import { getGenerator } from '../../src/core/map/generators';
import { SeededRandom } from '../../src/shared/random';

const seeds = [1, 2, 3, 4, 5];
const width = 270;
const height = 156;

const gen = getGenerator(BiomeType.CAVE_SYSTEM);
console.log(`Generator: ${gen.name}`);

for (const seed of seeds) {
  const t0 = performance.now();
  const rng = new SeededRandom(seed);
  const map = gen.generate(
    {
      seed,
      biome: BiomeType.CAVE_SYSTEM,
      widthTiles: width,
      heightTiles: height,
      roomWidthRange: [7, 16],
      roomHeightRange: [6, 14],
      maxRooms: 55,
      floorDensity: 0.45,
      tileSizeFt: 4.0,
    },
    rng,
  );
  const rooms = map.roomGraph.getAll();
  const roleCounts: Record<string, number> = {};
  for (const r of rooms) {
    roleCounts[r.role] = (roleCounts[r.role] ?? 0) + 1;
  }
  const passable = countPassable(map.tileMap, width, height);
  const elapsed = Math.round(performance.now() - t0);
  console.log(
    `seed=${seed}  ${elapsed}ms  rooms=${rooms.length}  passable=${passable}/${width * height}  roles=${JSON.stringify(roleCounts)}`,
  );
}

function countPassable(
  tileMap: { isPassable: (x: number, y: number) => boolean },
  w: number,
  h: number,
): number {
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (tileMap.isPassable(x, y)) n++;
    }
  }
  return n;
}
