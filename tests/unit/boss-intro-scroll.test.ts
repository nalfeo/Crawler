/**
 * Scroll-window math for the fixed-size boss introduction sheet.
 *
 * These are the pure helpers behind `BossIntroUI`'s flavour viewport: the sheet
 * never resizes, so long Director copy has to clamp, window, and drive a
 * scrollbar thumb correctly.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MIN_THUMB_HEIGHT,
  computeScrollThumb,
  computeScrollWindow,
} from '../../src/engine/boss-intro-scroll.js';

describe('computeScrollWindow', () => {
  it('reports copy that fits as not scrollable', () => {
    const window = computeScrollWindow(4, 6, 0);
    expect(window).toEqual({ index: 0, maxIndex: 0, visibleLines: 6, scrollable: false });
  });

  it('clamps the index to the last full page', () => {
    expect(computeScrollWindow(20, 6, 99).index).toBe(14);
    expect(computeScrollWindow(20, 6, -5).index).toBe(0);
    expect(computeScrollWindow(20, 6, 3).index).toBe(3);
  });

  it('always shows at least one line even in a degenerate viewport', () => {
    expect(computeScrollWindow(20, 0, 0).visibleLines).toBe(1);
    expect(computeScrollWindow(0, 0, 0).visibleLines).toBe(1);
  });

  it('never lets the window run past the end of the copy', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: -50, max: 250 }),
        (total, visible, requested) => {
          const window = computeScrollWindow(total, visible, requested);
          expect(window.index).toBeGreaterThanOrEqual(0);
          expect(window.index + window.visibleLines).toBeGreaterThanOrEqual(Math.min(total, 1));
          expect(window.index).toBeLessThanOrEqual(Math.max(0, total - window.visibleLines));
        },
      ),
    );
  });
});

describe('computeScrollThumb', () => {
  it('fills the track when nothing scrolls', () => {
    const window = computeScrollWindow(4, 10, 0);
    const thumb = computeScrollThumb(100, 200, window, 4);
    expect(thumb.y).toBe(100);
    expect(thumb.height).toBe(200);
  });

  it('sits flush with the bottom of the track at maximum scroll', () => {
    const window = computeScrollWindow(40, 8, 999);
    const thumb = computeScrollThumb(100, 200, window, 40);
    expect(thumb.y + thumb.height).toBeCloseTo(300, 5);
  });

  it('keeps the thumb grabbable on very long copy', () => {
    const window = computeScrollWindow(4000, 8, 0);
    const thumb = computeScrollThumb(0, 120, window, 4000);
    expect(thumb.height).toBeGreaterThanOrEqual(MIN_THUMB_HEIGHT);
  });

  it('stays inside the track for every scroll position', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 300 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 300 }),
        (total, visible, requested) => {
          const window = computeScrollWindow(total, visible, requested);
          const thumb = computeScrollThumb(50, 180, window, total);
          expect(thumb.y).toBeGreaterThanOrEqual(50);
          expect(thumb.y + thumb.height).toBeLessThanOrEqual(50 + 180 + 1e-6);
        },
      ),
    );
  });
});
