/**
 * Unit tests for the AI Runner Lab path overlay geometry.
 *
 * These verify that the overlay reconstructs the string-pulled, diagonal path the
 * behaviour-tree AI actually walks rather than the raw 4-connected zigzag.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSmoothedOverlayPath,
  hasClearLineOfSight,
  type OverlayPoint,
} from '../../../src/labs/ai-runner-lab/path-overlay.js';

/** Everything passable — open ground. */
const allPassable = (): boolean => true;

describe('hasClearLineOfSight', () => {
  it('reports clear sight across open ground', () => {
    expect(hasClearLineOfSight(0, 0, 100, 100, allPassable)).toBe(true);
  });

  it('reports blocked sight when a sample lands on an impassable cell', () => {
    // A vertical wall band around x === 50 blocks the straight corridor 0 -> 100.
    const wallAt50 = (x: number): boolean => !(x >= 45 && x <= 55);
    expect(hasClearLineOfSight(0, 0, 100, 0, wallAt50)).toBe(false);
  });

  it('checks the endpoint when start and end coincide', () => {
    expect(hasClearLineOfSight(10, 10, 10, 10, () => false)).toBe(false);
    expect(hasClearLineOfSight(10, 10, 10, 10, allPassable)).toBe(true);
  });

  it('rejects a diagonal that would cut through a blocked corner', () => {
    const isPassable = (x: number, y: number): boolean => {
      const tx = Math.floor(x / 32);
      const ty = Math.floor(y / 32);
      return !((tx === 2 && ty === 1) || (tx === 1 && ty === 2));
    };
    expect(hasClearLineOfSight(48, 48, 80, 80, isPassable)).toBe(false);
  });
});

describe('buildSmoothedOverlayPath', () => {
  const start: OverlayPoint = { x: 0, y: 0 };

  it('returns only the start point when there are no waypoints', () => {
    const path = buildSmoothedOverlayPath(start, [], allPassable);
    expect(path).toEqual([{ x: 0, y: 0 }]);
  });

  it('collapses a zigzag grid path into a single diagonal on open ground', () => {
    // Raw 4-connected waypoints stair-stepping toward (96, 96).
    const zigzag: OverlayPoint[] = [
      { x: 32, y: 0 },
      { x: 32, y: 32 },
      { x: 64, y: 32 },
      { x: 64, y: 64 },
      { x: 96, y: 64 },
      { x: 96, y: 96 },
    ];
    const path = buildSmoothedOverlayPath(start, zigzag, allPassable);
    // With full visibility the string-pull jumps straight from the player to the
    // final waypoint — no intermediate zigzag vertices.
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 96, y: 96 },
    ]);
  });

  it('keeps a corner vertex when a wall blocks the direct diagonal', () => {
    // Block the diagonal interior so the player cannot see the far waypoint
    // directly, but can see the corner, then the goal from the corner.
    const corner: OverlayPoint = { x: 0, y: 100 };
    const goal: OverlayPoint = { x: 100, y: 100 };
    const isPassable = (x: number, y: number): boolean => {
      // Impassable wedge above the L-shaped corridor blocks the start->goal line.
      return !(x > 5 && y < 95);
    };
    const path = buildSmoothedOverlayPath(start, [corner, goal], isPassable);
    expect(path).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ]);
  });

  it('always makes forward progress and terminates when nothing is visible', () => {
    // No cell is passable: every line-of-sight check fails, so the helper falls
    // back to walking waypoints one at a time without looping forever.
    const waypoints: OverlayPoint[] = [
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 30, y: 0 },
    ];
    const path = buildSmoothedOverlayPath(start, waypoints, () => false);
    expect(path).toEqual([{ x: 0, y: 0 }, ...waypoints]);
  });

  it('does not revisit waypoints already behind the player', () => {
    // Caller slices to upcoming waypoints; the helper should only emit forward
    // points plus the start anchor.
    const upcoming: OverlayPoint[] = [
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ];
    const path = buildSmoothedOverlayPath(start, upcoming, allPassable);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[path.length - 1]).toEqual({ x: 100, y: 0 });
    expect(path.length).toBeLessThanOrEqual(upcoming.length + 1);
  });
});
