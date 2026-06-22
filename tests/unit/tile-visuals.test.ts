import { describe, it, expect } from 'vitest';
import {
  getTileVisual,
  neighborMask,
  resolveFrame,
} from '../../src/engine/sprites/tile-visuals.js';
import { TerrainType } from '../../src/shared/map-types.js';

// Helper — build a flat terrain array from a 2-D string grid.
// 'W' = STONE_WALL, '.' = STONE_FLOOR, ' ' = VOID
function makeMap(rows: string[]): { terrain: Uint8Array; width: number; height: number } {
  const height = rows.length;
  const width = rows[0]!.length;
  const terrain = new Uint8Array(width * height);
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const ch = rows[ty]![tx];
      if (ch === 'W') terrain[ty * width + tx] = TerrainType.STONE_WALL;
      else if (ch === '.') terrain[ty * width + tx] = TerrainType.STONE_FLOOR;
      else terrain[ty * width + tx] = TerrainType.VOID;
    }
  }
  return { terrain, width, height };
}

describe('neighborMask', () => {
  it('returns 0 for an isolated tile (no same-terrain neighbours)', () => {
    const { terrain, width, height } = makeMap(['...', '.W.', '...']);
    expect(neighborMask(terrain, width, height, 1, 1, TerrainType.STONE_WALL)).toBe(0);
  });

  it('sets bit 0 (N=1) when the north neighbour matches', () => {
    const { terrain, width, height } = makeMap(['.W.', '.W.', '...']);
    // tile (1,1): north (1,0) is STONE_WALL → bit 0
    expect(neighborMask(terrain, width, height, 1, 1, TerrainType.STONE_WALL)).toBe(1);
  });

  it('sets bit 1 (E=2) when the east neighbour matches', () => {
    const { terrain, width, height } = makeMap(['...', '.WW', '...']);
    // tile (1,1): east (2,1) is STONE_WALL → bit 1
    expect(neighborMask(terrain, width, height, 1, 1, TerrainType.STONE_WALL)).toBe(2);
  });

  it('sets bit 2 (S=4) when the south neighbour matches', () => {
    const { terrain, width, height } = makeMap(['...', '.W.', '.W.']);
    // tile (1,1): south (1,2) is STONE_WALL → bit 2
    expect(neighborMask(terrain, width, height, 1, 1, TerrainType.STONE_WALL)).toBe(4);
  });

  it('sets bit 3 (W=8) when the west neighbour matches', () => {
    const { terrain, width, height } = makeMap(['...', 'WW.', '...']);
    // tile (1,1): west (0,1) is STONE_WALL → bit 3
    expect(neighborMask(terrain, width, height, 1, 1, TerrainType.STONE_WALL)).toBe(8);
  });

  it('returns 15 when all four cardinal neighbours match (fully surrounded)', () => {
    const { terrain, width, height } = makeMap(['.W.', 'WWW', '.W.']);
    // tile (1,1): all four neighbours are STONE_WALL → bits 0+1+2+3 = 15
    expect(neighborMask(terrain, width, height, 1, 1, TerrainType.STONE_WALL)).toBe(15);
  });

  it('returns 5 for a vertical run (N+S connected, E+W clear)', () => {
    const { terrain, width, height } = makeMap(['.W.', '.W.', '.W.']);
    // tile (1,1): N=1, S=4 → mask 5
    expect(neighborMask(terrain, width, height, 1, 1, TerrainType.STONE_WALL)).toBe(5);
  });

  it('returns 10 for a horizontal run (E+W connected, N+S clear)', () => {
    const { terrain, width, height } = makeMap(['...', 'WWW', '...']);
    // tile (1,1): E=2, W=8 → mask 10
    expect(neighborMask(terrain, width, height, 1, 1, TerrainType.STONE_WALL)).toBe(10);
  });

  it('does not match neighbours of a different terrain type', () => {
    const { terrain, width, height } = makeMap(['.W.', 'W.W', '.W.']);
    // tile (1,1) is STONE_FLOOR; all four neighbours are STONE_WALL.
    // Checking for STONE_FLOOR → none of the WALL neighbours match → 0.
    expect(neighborMask(terrain, width, height, 1, 1, TerrainType.STONE_FLOOR)).toBe(0);
  });

  it('treats out-of-bounds neighbours as non-matching (top-left corner)', () => {
    const { terrain, width, height } = makeMap(['WW', 'W.']);
    // tile (0,0): N and W are out-of-bounds → bits 1 (E) and 2 (S) only = 6
    expect(neighborMask(terrain, width, height, 0, 0, TerrainType.STONE_WALL)).toBe(6);
  });

  it('treats out-of-bounds neighbours as non-matching (bottom-right corner)', () => {
    const { terrain, width, height } = makeMap(['.W', 'WW']);
    // tile (1,1): S and E are out-of-bounds → bits 0 (N) and 3 (W) = 9
    expect(neighborMask(terrain, width, height, 1, 1, TerrainType.STONE_WALL)).toBe(9);
  });
});

describe('tile visuals mapping and frame resolution', () => {
  it('maps updated cave/corridor/safe-room placeholders to expected frames', () => {
    expect(getTileVisual(TerrainType.CAVE_WALL)?.frame).toBe(0);
    expect(getTileVisual(TerrainType.CAVE_FLOOR)?.frame).toBe(53);
    expect(getTileVisual(TerrainType.CORRIDOR)?.frame).toBe(8);
    expect(getTileVisual(TerrainType.SAFE_ROOM_FLOOR)?.frame).toBe(9);
  });

  it('leaves known broken placeholders unmapped so renderers use color fallback', () => {
    expect(getTileVisual(TerrainType.LAVA)).toBeUndefined();
    expect(getTileVisual(TerrainType.DIRT)).toBeUndefined();
    expect(getTileVisual(TerrainType.WOOD_FLOOR)).toBeUndefined();
  });

  it('resolveFrame returns base frame for non-autotiled terrain', () => {
    const visual = getTileVisual(TerrainType.CORRIDOR);
    expect(visual).toBeDefined();
    const { terrain, width, height } = makeMap(['...', '.W.', '...']);
    expect(resolveFrame(visual!, terrain, width, height, 1, 1, TerrainType.CORRIDOR)).toBe(8);
  });

  it('resolveFrame uses the neighbor mask for blob-tile autotiling', () => {
    const visual = getTileVisual(TerrainType.CAVE_WALL);
    expect(visual?.frames).toBeDefined();
    const terrain = new Uint8Array([
      TerrainType.CAVE_WALL,
      TerrainType.CAVE_WALL,
      TerrainType.CAVE_WALL,
      TerrainType.CAVE_WALL,
      TerrainType.CAVE_WALL,
      TerrainType.CAVE_WALL,
      TerrainType.CAVE_WALL,
      TerrainType.CAVE_WALL,
      TerrainType.CAVE_WALL,
    ]);
    expect(resolveFrame(visual!, terrain, 3, 3, 1, 1, TerrainType.CAVE_WALL)).toBe(0);
  });
});
