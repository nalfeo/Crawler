/**
 * Unit tests for the `anchor-derivable` sensor wrapper. The wrapper itself
 * is thin — it dispatches into `deriveAnchor` and adapts the result shape
 * into a `SensorResult` — so these tests focus on shape, surfacing the
 * anchor on success, and the `isAnchorDerivableOk` type guard.
 *
 * Algorithm correctness lives in `./derive-anchor.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  ANCHOR_DERIVABLE_SENSOR,
  anchorDerivable,
  isAnchorDerivableOk,
} from '../../../scripts/sprites/sensors/anchor-derivable.js';
import type { RgbaImage, SensorResult } from '../../../scripts/sprites/sensors/common.js';

function makeImage(
  width: number,
  height: number,
  paint: (x: number, y: number) => boolean,
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      data[idx + 3] = paint(x, y) ? 255 : 0;
    }
  }
  return { width, height, data };
}

describe('anchorDerivable', () => {
  it('returns an ok result carrying the derived anchor', () => {
    const img = makeImage(16, 16, (x, y) => y === 15 && (x === 7 || x === 8));
    const result = anchorDerivable(img);
    expect(result.ok).toBe(true);
    expect(result.sensor).toBe(ANCHOR_DERIVABLE_SENSOR);
    if (result.ok) {
      expect(result.anchor).toEqual({ x: 7, y: 15 });
    }
  });

  it('returns a failing result with a stable reason on bad input', () => {
    const img = makeImage(16, 16, () => false);
    const result = anchorDerivable(img);
    expect(result.ok).toBe(false);
    expect(result.sensor).toBe(ANCHOR_DERIVABLE_SENSOR);
    if (!result.ok) {
      expect(result.reason).toMatch(/no opaque pixels/);
    }
  });

  it('threads bandRows and centerToleranceX overrides into deriveAnchor', () => {
    const img = makeImage(16, 16, (x, y) => y === 10 && (x === 7 || x === 8));
    expect(anchorDerivable(img).ok).toBe(false); // default bandRows rejects y=10
    const widened = anchorDerivable(img, { bandRows: 6 });
    expect(widened.ok).toBe(true);
    if (widened.ok) expect(widened.anchor.y).toBe(10);
  });
});

describe('isAnchorDerivableOk', () => {
  it('narrows a successful anchor-derivable result', () => {
    const img = makeImage(16, 16, (x, y) => y === 15 && (x === 7 || x === 8));
    const result: SensorResult = anchorDerivable(img);
    expect(isAnchorDerivableOk(result)).toBe(true);
    if (isAnchorDerivableOk(result)) {
      // Type-narrowed: anchor is present.
      expect(result.anchor.x).toBe(7);
      expect(result.anchor.y).toBe(15);
    }
  });

  it('returns false for a non-anchor-derivable sensor name', () => {
    const result: SensorResult = { ok: true, sensor: 'some-other-sensor' };
    expect(isAnchorDerivableOk(result)).toBe(false);
  });

  it('returns false for a failing anchor-derivable result', () => {
    const img = makeImage(16, 16, () => false);
    expect(isAnchorDerivableOk(anchorDerivable(img))).toBe(false);
  });

  it('returns false when the anchor property is missing or malformed', () => {
    const malformed: SensorResult = { ok: true, sensor: ANCHOR_DERIVABLE_SENSOR };
    expect(isAnchorDerivableOk(malformed)).toBe(false);
  });
});
