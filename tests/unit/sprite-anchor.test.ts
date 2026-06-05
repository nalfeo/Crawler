import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HANDHELD_SPRITE_ANCHOR,
  isValidAnchor,
  resolveHandheldAnchor,
  type SpriteAnchor,
} from '../../src/shared/sprite-anchor.js';

describe('SpriteAnchor', () => {
  describe('DEFAULT_HANDHELD_SPRITE_ANCHOR', () => {
    it('is bottom-center of a 16x16 frame, one pixel above the bottom edge', () => {
      // Mirrors the pipeline-side weapon brief default. Changing this without
      // updating scripts/sprites is a contract break.
      expect(DEFAULT_HANDHELD_SPRITE_ANCHOR).toEqual({ x: 8, y: 14 });
    });

    it('is a valid anchor inside a 16x16 frame', () => {
      expect(isValidAnchor(DEFAULT_HANDHELD_SPRITE_ANCHOR, 16, 16)).toBe(true);
    });
  });

  describe('resolveHandheldAnchor', () => {
    it('returns the supplied anchor when one is provided', () => {
      const anchor: SpriteAnchor = { x: 3, y: 9 };
      expect(resolveHandheldAnchor(anchor)).toBe(anchor);
    });

    it('returns the default when called with no argument', () => {
      expect(resolveHandheldAnchor()).toBe(DEFAULT_HANDHELD_SPRITE_ANCHOR);
    });

    it('returns the default when called with undefined', () => {
      expect(resolveHandheldAnchor(undefined)).toBe(DEFAULT_HANDHELD_SPRITE_ANCHOR);
    });
  });

  describe('isValidAnchor', () => {
    it('accepts integer coordinates strictly inside the frame', () => {
      expect(isValidAnchor({ x: 0, y: 0 }, 16, 16)).toBe(true);
      expect(isValidAnchor({ x: 15, y: 15 }, 16, 16)).toBe(true);
      expect(isValidAnchor({ x: 8, y: 14 }, 16, 16)).toBe(true);
    });

    it('rejects coordinates equal to or greater than the frame size', () => {
      expect(isValidAnchor({ x: 16, y: 0 }, 16, 16)).toBe(false);
      expect(isValidAnchor({ x: 0, y: 16 }, 16, 16)).toBe(false);
      expect(isValidAnchor({ x: 32, y: 5 }, 16, 16)).toBe(false);
    });

    it('rejects negative coordinates', () => {
      expect(isValidAnchor({ x: -1, y: 0 }, 16, 16)).toBe(false);
      expect(isValidAnchor({ x: 0, y: -1 }, 16, 16)).toBe(false);
    });

    it('rejects fractional coordinates', () => {
      expect(isValidAnchor({ x: 8.5, y: 14 }, 16, 16)).toBe(false);
      expect(isValidAnchor({ x: 8, y: 14.1 }, 16, 16)).toBe(false);
    });

    it('rejects non-finite coordinates', () => {
      expect(isValidAnchor({ x: Number.NaN, y: 0 }, 16, 16)).toBe(false);
      expect(isValidAnchor({ x: 0, y: Number.POSITIVE_INFINITY }, 16, 16)).toBe(false);
    });

    it('respects non-square frame dimensions', () => {
      expect(isValidAnchor({ x: 31, y: 15 }, 32, 16)).toBe(true);
      expect(isValidAnchor({ x: 16, y: 15 }, 16, 32)).toBe(false);
      expect(isValidAnchor({ x: 15, y: 31 }, 16, 32)).toBe(true);
    });
  });
});
