import { describe, expect, it } from 'vitest';
import type { DoorUnlockRequirement } from '../../src/core/door-navigation.js';
import {
  DwellTracker,
  findNearestFrontierTile,
  isDoorKnownLocked,
  nextStuckFrames,
  pickNearestPoi,
  updateLockedDoorMemory,
  type AILockedDoorMemory,
  type FrontierGrid,
  type PoiCandidate,
} from '../../src/game/ai/exploration.js';

// ---------------------------------------------------------------------------
// Test grid helper (C1)
// ---------------------------------------------------------------------------
//
// Build a FrontierGrid from an ASCII map so the BFS can be exercised over hand
// drawn fog. Legend:
//   S  start tile          (seen + passable)
//   .  explored floor      (seen + passable)
//   #  explored wall       (seen + NOT passable)
//   ?  fog floor           (unseen + passable underneath)
//   x  fog wall            (unseen + NOT passable)
//
// `tileDistanceFt` is measured from the start tile in whole tiles * TILE_FT so
// the minimum-distance gate is easy to reason about.

const TILE_FT = 4;

function parseGrid(rows: readonly string[]): {
  grid: FrontierGrid;
  start: { x: number; y: number };
  visited: Uint8Array;
} {
  const height = rows.length;
  const width = rows[0]!.length;
  let startX = 0;
  let startY = 0;
  const seen: boolean[] = [];
  const passable: boolean[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = rows[y]!;
    for (let x = 0; x < width; x += 1) {
      const ch = row[x]!;
      if (ch === 'S') {
        startX = x;
        startY = y;
      }
      seen.push(ch === 'S' || ch === '.' || ch === '#');
      passable.push(ch === 'S' || ch === '.' || ch === '?');
    }
  }
  const grid: FrontierGrid = {
    width,
    height,
    index: (tx, ty) => (tx < 0 || ty < 0 || tx >= width || ty >= height ? -1 : ty * width + tx),
    isSeen: (idx) => seen[idx] === true,
    isPassable: (tx, ty) => passable[ty * width + tx] === true,
    tileDistanceFt: (tx, ty) => Math.hypot(tx - startX, ty - startY) * TILE_FT,
  };
  return { grid, start: { x: startX, y: startY }, visited: new Uint8Array(width * height) };
}

describe('findNearestFrontierTile (C1 unexplored-tile preference)', () => {
  it('returns the nearest seen tile that borders fog', () => {
    // x0..x2 explored, x3 fog → x2 is the frontier (seen, unseen neighbour).
    const { grid, start, visited } = parseGrid(['S..?']);
    const frontier = findNearestFrontierTile(grid, start.x, start.y, 0, 1000, visited);
    expect(frontier).toEqual({ tileX: 2, tileY: 0 });
  });

  it('honours the minimum-distance gate by skipping a too-close frontier', () => {
    // (0,0) borders fog at (0,1) so it is a frontier at distance 0; with a
    // minimum of 2.5ft it is rejected and BFS continues to (1,1) (~5.7ft).
    const { grid, start, visited } = parseGrid(['S...', '?..?']);
    const close = findNearestFrontierTile(grid, start.x, start.y, 0, 1000, visited);
    expect(close).toEqual({ tileX: 0, tileY: 0 });

    const gated = findNearestFrontierTile(grid, start.x, start.y, 2.5, 1000, visited);
    expect(gated).toEqual({ tileX: 1, tileY: 1 });
  });

  it('returns null when the only frontier is closer than the minimum distance', () => {
    // Single frontier at x2 (8ft); a 10ft minimum leaves nothing reachable.
    const { grid, start, visited } = parseGrid(['S..?']);
    expect(findNearestFrontierTile(grid, start.x, start.y, 10, 1000, visited)).toBeNull();
  });

  it('only expands through seen, passable ground (a wall blocks the fog behind it)', () => {
    // x1 is a seen wall, so BFS cannot reach x2's fog and there is no other
    // frontier: a seen wall neighbour does not itself count as fog.
    const { grid, start, visited } = parseGrid(['S#?']);
    expect(findNearestFrontierTile(grid, start.x, start.y, 0, 1000, visited)).toBeNull();
  });

  it('respects the maxTiles expansion cap', () => {
    // Frontier sits at x3; capping expansion at 2 tiles never reaches it.
    const rows = ['S...?'];
    const capped = parseGrid(rows);
    expect(findNearestFrontierTile(capped.grid, 0, 0, 0, 2, capped.visited)).toBeNull();

    const uncapped = parseGrid(rows);
    expect(findNearestFrontierTile(uncapped.grid, 0, 0, 0, 1000, uncapped.visited)).toEqual({
      tileX: 3,
      tileY: 0,
    });
  });

  it('returns null when the start tile is out of bounds', () => {
    const { grid, visited } = parseGrid(['S..?']);
    expect(findNearestFrontierTile(grid, -1, 0, 0, 1000, visited)).toBeNull();
    expect(findNearestFrontierTile(grid, 99, 0, 0, 1000, visited)).toBeNull();
  });

  it('returns null on a fully-explored region with no fog', () => {
    const { grid, start, visited } = parseGrid(['S..', '...']);
    expect(findNearestFrontierTile(grid, start.x, start.y, 0, 1000, visited)).toBeNull();
  });

  it('is deterministic across repeated calls with the same inputs', () => {
    const a = parseGrid(['S...', '?..?']);
    const b = parseGrid(['S...', '?..?']);
    const first = findNearestFrontierTile(a.grid, 0, 0, 2.5, 1000, a.visited);
    const second = findNearestFrontierTile(b.grid, 0, 0, 2.5, 1000, b.visited);
    expect(first).toEqual(second);
  });

  it('zero-fills the supplied visited buffer (stale marks do not leak)', () => {
    const { grid, start, visited } = parseGrid(['S..?']);
    visited.fill(1); // pre-dirty every cell
    expect(findNearestFrontierTile(grid, start.x, start.y, 0, 1000, visited)).toEqual({
      tileX: 2,
      tileY: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// pickNearestPoi (C2)
// ---------------------------------------------------------------------------

interface TestPoi extends PoiCandidate {
  readonly id: string;
}

function poi(id: string, x: number, y: number, relevant: boolean): TestPoi {
  return { id, x, y, relevant };
}

describe('pickNearestPoi (C2 minimap / POI seeking)', () => {
  it('picks the nearest relevant POI within the radius', () => {
    const chosen = pickNearestPoi([poi('far', 100, 0, true), poi('near', 10, 0, true)], 0, 0, 200);
    expect(chosen?.id).toBe('near');
  });

  it('skips handled (irrelevant) POIs even when they are closer', () => {
    const chosen = pickNearestPoi(
      [poi('handled', 5, 0, false), poi('todo', 50, 0, true)],
      0,
      0,
      200,
    );
    expect(chosen?.id).toBe('todo');
  });

  it('ignores POIs outside the scan radius', () => {
    expect(pickNearestPoi([poi('away', 500, 0, true)], 0, 0, 100)).toBeNull();
  });

  it('excludes a POI sitting exactly on the radius boundary', () => {
    // minDist starts at maxRadiusFt and selection is strict <, so dist == radius
    // is not selected.
    expect(pickNearestPoi([poi('edge', 100, 0, true)], 0, 0, 100)).toBeNull();
  });

  it('resolves ties to the first candidate in iteration order (deterministic)', () => {
    const chosen = pickNearestPoi([poi('a', 10, 0, true), poi('b', 0, 10, true)], 0, 0, 200);
    expect(chosen?.id).toBe('a');
  });

  it('returns null for an empty candidate set', () => {
    expect(pickNearestPoi([], 0, 0, 200)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateLockedDoorMemory / isDoorKnownLocked (C3)
// ---------------------------------------------------------------------------

function req(
  goalIds: string[] = [],
  itemIds: string[] = [],
  timerMs: number[] = [],
): DoorUnlockRequirement {
  return { goalIds, itemIds, timerMs };
}

function door(eid: number, tileX: number, tileY: number): AILockedDoorMemory {
  return { eid, tileX, tileY, unlockRequirement: req(['floor1-cleared']) };
}

describe('updateLockedDoorMemory / isDoorKnownLocked (C3 locked-door memory)', () => {
  it('records every currently-blocked door', () => {
    const known = new Map<number, AILockedDoorMemory>();
    updateLockedDoorMemory(known, [door(7, 3, 4), door(9, 5, 6)]);
    expect(isDoorKnownLocked(known, 7)).toBe(true);
    expect(isDoorKnownLocked(known, 9)).toBe(true);
    expect(known.get(7)).toEqual(door(7, 3, 4));
  });

  it('forgets a remembered door once it is no longer blocked (unlocked)', () => {
    const known = new Map<number, AILockedDoorMemory>();
    updateLockedDoorMemory(known, [door(7, 3, 4), door(9, 5, 6)]);
    // Door 9 unlocked: only 7 still blocked this poll.
    updateLockedDoorMemory(known, [door(7, 3, 4)]);
    expect(isDoorKnownLocked(known, 7)).toBe(true);
    expect(isDoorKnownLocked(known, 9)).toBe(false);
  });

  it('clears all memory when nothing is blocked', () => {
    const known = new Map<number, AILockedDoorMemory>();
    updateLockedDoorMemory(known, [door(7, 3, 4)]);
    updateLockedDoorMemory(known, []);
    expect(known.size).toBe(0);
    expect(isDoorKnownLocked(known, 7)).toBe(false);
  });

  it('refreshes the stored tile when a door entity reports a new position', () => {
    const known = new Map<number, AILockedDoorMemory>();
    updateLockedDoorMemory(known, [door(7, 3, 4)]);
    updateLockedDoorMemory(known, [door(7, 8, 1)]);
    expect(known.get(7)?.tileX).toBe(8);
    expect(known.get(7)?.tileY).toBe(1);
  });

  it('is idempotent for a stable blocked set', () => {
    const known = new Map<number, AILockedDoorMemory>();
    const blocked = [door(7, 3, 4), door(9, 5, 6)];
    updateLockedDoorMemory(known, blocked);
    const snapshot = new Map(known);
    updateLockedDoorMemory(known, blocked);
    expect(known).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// nextStuckFrames (C4)
// ---------------------------------------------------------------------------

describe('nextStuckFrames (C4 per-frame stuck counter)', () => {
  it('increments while movement stays below the epsilon', () => {
    expect(nextStuckFrames(0, 0.125, 0.5)).toBe(1);
    expect(nextStuckFrames(5, 0.4875, 0.5)).toBe(6);
  });

  it('resets to zero the moment real travel happens', () => {
    expect(nextStuckFrames(10, 1, 0.5)).toBe(0);
  });

  it('treats movement exactly at the epsilon as real travel (strict <)', () => {
    expect(nextStuckFrames(10, 0.5, 0.5)).toBe(0);
  });

  it('accumulates across a run of stalled frames', () => {
    let frames = 0;
    for (let i = 0; i < 5; i += 1) {
      frames = nextStuckFrames(frames, 0, 0.5);
    }
    expect(frames).toBe(5);
    frames = nextStuckFrames(frames, 12.5, 0.5); // one good step clears it
    expect(frames).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DwellTracker (C4)
// ---------------------------------------------------------------------------

describe('DwellTracker (C4 net-displacement watchdog)', () => {
  it('arms on the first update and reports zero parked frames', () => {
    const dwell = new DwellTracker(8, 4);
    expect(dwell.update(12.5, 12.5)).toBe('armed');
    expect(dwell.isActive).toBe(true);
    expect(dwell.framesParked).toBe(0);
  });

  it('accumulates parked frames while inside the escape circle', () => {
    const dwell = new DwellTracker(8, 4);
    dwell.update(12.5, 12.5); // armed
    expect(dwell.update(12.625, 12.5)).toBe('accumulating');
    expect(dwell.update(12.5, 12.625)).toBe('accumulating');
    expect(dwell.framesParked).toBe(2);
  });

  it('re-anchors and forgives the counter when net travel escapes the circle', () => {
    const dwell = new DwellTracker(8, 10);
    dwell.update(0, 0); // armed
    dwell.update(0.125, 0); // accumulating, frames=1
    expect(dwell.framesParked).toBe(1);
    expect(dwell.update(25, 0)).toBe('progress'); // moved > 8ft
    expect(dwell.framesParked).toBe(0);
  });

  it('treats an explicit progress signal as escaping even without movement', () => {
    const dwell = new DwellTracker(8, 10);
    dwell.update(0, 0); // armed
    dwell.update(0.125, 0); // accumulating
    expect(dwell.update(0.125, 0, true)).toBe('progress');
    expect(dwell.framesParked).toBe(0);
  });

  it('fires after frameLimit parked frames, then auto-resets to re-arm', () => {
    const dwell = new DwellTracker(8, 3);
    expect(dwell.update(0, 0)).toBe('armed');
    expect(dwell.update(0, 0)).toBe('accumulating'); // 1
    expect(dwell.update(0, 0)).toBe('accumulating'); // 2
    expect(dwell.update(0, 0)).toBe('accumulating'); // 3
    expect(dwell.update(0, 0)).toBe('fired'); // 4 > limit 3
    // Auto-reset: the next update re-arms a fresh episode.
    expect(dwell.isActive).toBe(false);
    expect(dwell.framesParked).toBe(0);
    expect(dwell.update(0, 0)).toBe('armed');
  });

  it('reset() forgets the current episode', () => {
    const dwell = new DwellTracker(8, 3);
    dwell.update(0, 0);
    dwell.update(0, 0);
    expect(dwell.isActive).toBe(true);
    dwell.reset();
    expect(dwell.isActive).toBe(false);
    expect(dwell.framesParked).toBe(0);
    expect(dwell.update(0, 0)).toBe('armed');
  });

  it('is deterministic for an identical update sequence', () => {
    const drive = (): string[] => {
      const dwell = new DwellTracker(6.25, 3);
      const steps: Array<[number, number]> = [
        [0, 0],
        [1.25, 0],
        [2.5, 0],
        [3.125, 0],
        [3.125, 0],
        [3.125, 0],
      ];
      return steps.map(([x, y]) => dwell.update(x, y));
    };
    expect(drive()).toEqual(drive());
  });
});
