import { it } from 'vitest';
import { SeededRandom } from '../../src/shared/random';
import { BiomeType, TileFlags } from '../../src/shared/map-types';
import type { MapConfig } from '../../src/shared/map-types';
import { DungeonGenerator } from '../../src/core/map/generators/DungeonGenerator';

it('checks seeds', () => {
  const cfg: MapConfig = {
    widthTiles: 120,
    heightTiles: 70,
    tileSizePx: 32,
    biome: BiomeType.BASIC_UNDERGROUND,
    seed: 42,
    roomWidthRange: [6, 14],
    roomHeightRange: [5, 13],
    maxRooms: 45,
    floorDensity: 0.42,
  };
  for (const seed of [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17, 20, 22, 23, 25, 30, 42, 50, 55, 60, 70, 80,
    99, 100, 123, 200, 256,
  ]) {
    const gen = new DungeonGenerator({ roomVariety: true });
    const floor = gen.generate({ ...cfg, seed }, new SeededRandom(seed));
    const w = floor.width,
      h = floor.height;
    const visited = new Uint8Array(w * h);
    const sp = floor.playerSpawn.y * w + floor.playerSpawn.x;
    visited[sp] = 1;
    const stack: number[] = [sp];
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
        const flags = floor.tileMap.flags[nIdx]!;
        if (flags & TileFlags.PASSABLE || flags & TileFlags.DOOR) {
          visited[nIdx] = 1;
          stack.push(nIdx);
        }
      }
    }
    let isolated = 0;
    for (let i = 0; i < w * h; i++) {
      const f = floor.tileMap.flags[i]!;
      if (f & TileFlags.PASSABLE && !(f & TileFlags.DOOR) && !visited[i]) isolated++;
    }
    console.log(
      `seed=${String(seed).padStart(3)}: rooms=${floor.rooms.length}, isolated=${isolated}, boss=${floor.bossStairRoom?.id ?? '-'}, safe=${floor.safeRoom?.id ?? '-'}`,
    );
  }
});
