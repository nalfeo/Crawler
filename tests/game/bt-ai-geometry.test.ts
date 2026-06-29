/**
 * Unit + property tests for {@link hasClearLineOfSight} — the pure line-of-sight
 * sampler extracted from the behavior-tree AI. The AI uses it to decide when it
 * may abandon tile-granular A* for a direct sub-tile approach onto a close
 * target, so the geometry must (a) reject any path that crosses a blocked tile,
 * (b) reject diagonal corner-cuts where both flanking tiles are blocked, and
 * (c) stay fully deterministic. These tests pin those invariants with a tiny
 * fake grid instead of constructing a real FloorMap.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { hasClearLineOfSight, type LineOfSightMap } from '../../src/game/ai/bt-ai-geometry.js';
import { LINE_OF_SIGHT_SAMPLE_FT } from '../../src/game/ai/bt-ai-tuning.js';

const TILE = 10;

/**
 * Build a {@link LineOfSightMap} from ASCII rows: `.` passable, `#` blocked.
 * Row index is tile-y, column index is tile-x; each tile spans `TILE` world ft.
 * Out-of-bounds world positions read as blocked (matches FloorMap semantics).
 */
function makeGrid(rows: string[]): LineOfSightMap {
  const grid = rows.map((r) => [...r]);
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  return {
    worldToTile: (x, y) => ({ x: Math.floor(x / TILE), y: Math.floor(y / TILE) }),
    isPassableAt: (x, y) => {
      const tx = Math.floor(x / TILE);
      const ty = Math.floor(y / TILE);
      if (ty < 0 || ty >= height || tx < 0 || tx >= width) return false;
      return grid[ty]![tx] === '.';
    },
  };
}

const tileCenter = (t: number) => t * TILE + TILE / 2;

describe('hasClearLineOfSight', () => {
  it('returns false when there is no map', () => {
    expect(hasClearLineOfSight(null, 0, 0, 10, 10)).toBe(false);
    expect(hasClearLineOfSight(undefined, 0, 0, 10, 10)).toBe(false);
  });

  it('reports the endpoint tile when start equals end (zero distance)', () => {
    const map = makeGrid(['.#']);
    // tile (0,0) passable, tile (1,0) blocked.
    expect(
      hasClearLineOfSight(map, tileCenter(0), tileCenter(0), tileCenter(0), tileCenter(0)),
    ).toBe(true);
    expect(
      hasClearLineOfSight(map, tileCenter(1), tileCenter(0), tileCenter(1), tileCenter(0)),
    ).toBe(false);
  });

  it('passes a straight clear corridor', () => {
    const map = makeGrid(['......']);
    expect(
      hasClearLineOfSight(map, tileCenter(0), tileCenter(0), tileCenter(5), tileCenter(0)),
    ).toBe(true);
  });

  it('blocks a corridor with a wall in the middle', () => {
    const map = makeGrid(['..#..']);
    expect(
      hasClearLineOfSight(map, tileCenter(0), tileCenter(0), tileCenter(4), tileCenter(0)),
    ).toBe(false);
  });

  it('rejects a diagonal that cuts a blocked corner, and accepts it once a flank opens', () => {
    // Diagonal from tile (0,0) to (1,1); flanking tiles (1,0) and (0,1) blocked.
    const blockedCorner = makeGrid(['.#', '#.']);
    expect(
      hasClearLineOfSight(
        blockedCorner,
        tileCenter(0),
        tileCenter(0),
        tileCenter(1),
        tileCenter(1),
        2,
      ),
    ).toBe(false);
    // Open one flank: the corner-cut guard no longer trips.
    const openFlank = makeGrid(['..', '#.']);
    expect(
      hasClearLineOfSight(openFlank, tileCenter(0), tileCenter(0), tileCenter(1), tileCenter(1), 2),
    ).toBe(true);
  });

  it('defaults the sample step to LINE_OF_SIGHT_SAMPLE_FT', () => {
    const map = makeGrid(['..#..']);
    const start = tileCenter(0);
    const end = tileCenter(4);
    expect(hasClearLineOfSight(map, start, tileCenter(0), end, tileCenter(0))).toBe(
      hasClearLineOfSight(map, start, tileCenter(0), end, tileCenter(0), LINE_OF_SIGHT_SAMPLE_FT),
    );
  });

  describe('properties', () => {
    const coord = fc.integer({ min: 5, max: 75 }); // stays inside an 8x8 grid interior

    it('always clears a fully passable arena', () => {
      const open = makeGrid(Array.from({ length: 8 }, () => '.'.repeat(8)));
      fc.assert(
        fc.property(coord, coord, coord, coord, (sx, sy, ex, ey) => {
          expect(hasClearLineOfSight(open, sx, sy, ex, ey)).toBe(true);
        }),
      );
    });

    it('never clears a fully blocked arena', () => {
      const solid = makeGrid(Array.from({ length: 8 }, () => '#'.repeat(8)));
      fc.assert(
        fc.property(coord, coord, coord, coord, (sx, sy, ex, ey) => {
          expect(hasClearLineOfSight(solid, sx, sy, ex, ey)).toBe(false);
        }),
      );
    });

    it('is deterministic for identical inputs (no hidden state)', () => {
      fc.assert(
        fc.property(
          fc.array(fc.boolean(), { minLength: 64, maxLength: 64 }),
          coord,
          coord,
          coord,
          coord,
          (cells, sx, sy, ex, ey) => {
            const rows = Array.from({ length: 8 }, (_, y) =>
              cells
                .slice(y * 8, y * 8 + 8)
                .map((c) => (c ? '.' : '#'))
                .join(''),
            );
            const map = makeGrid(rows);
            const a = hasClearLineOfSight(map, sx, sy, ex, ey);
            const b = hasClearLineOfSight(map, sx, sy, ex, ey);
            expect(a).toBe(b);
          },
        ),
      );
    });
  });
});
