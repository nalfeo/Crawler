import { describe, expect, it } from 'vitest';
import {
  cellPxToSubFactor,
  DEFAULT_FOV_PRESET,
  DEFAULT_FOV_SUB_FACTOR,
  FOV_PRESET_CELL_PX,
  FOV_TILE_SIZE_PX,
  getFovPresetCellPx,
  getFovPresetSubFactor,
  MAX_FOV_SUB_FACTOR,
  subFactorToCellPx,
  type FovPresetId,
} from '../../src/engine/fov/fov-config';

/**
 * Pure conversion coverage for the FOV granularity config bridge. `subFactor` is
 * the canonical core integer; `cellPx` is the pixel-facing UI value. These lock
 * the exact preset ↔ factor mapping the lab relies on and the clamp behavior at
 * the extremes.
 */
describe('fov-config', () => {
  it('exposes the canonical 32px tile size and quarter-tile default', () => {
    expect(FOV_TILE_SIZE_PX).toBe(32);
    expect(DEFAULT_FOV_SUB_FACTOR).toBe(2);
    expect(MAX_FOV_SUB_FACTOR).toBe(8);
    expect(DEFAULT_FOV_PRESET).toBe('halfTile');
  });

  describe('subFactorToCellPx', () => {
    it('maps each factor to its exact cell size at 32px tiles', () => {
      expect(subFactorToCellPx(1)).toBe(32);
      expect(subFactorToCellPx(2)).toBe(16);
      expect(subFactorToCellPx(4)).toBe(8);
      expect(subFactorToCellPx(8)).toBe(4);
    });

    it('normalizes/clamps the factor before converting', () => {
      expect(subFactorToCellPx(999)).toBe(4); // clamped to factor 8
      expect(subFactorToCellPx(0)).toBe(32); // clamped to factor 1
    });

    it('honors a custom tile size', () => {
      expect(subFactorToCellPx(2, 64)).toBe(32);
    });
  });

  describe('cellPxToSubFactor', () => {
    it('maps each preset cell size to its exact integer factor', () => {
      expect(cellPxToSubFactor(32)).toBe(1);
      expect(cellPxToSubFactor(16)).toBe(2);
      expect(cellPxToSubFactor(8)).toBe(4);
      expect(cellPxToSubFactor(4)).toBe(8);
    });

    it('clamps a too-fine cell size to the max factor', () => {
      expect(cellPxToSubFactor(2)).toBe(MAX_FOV_SUB_FACTOR);
      expect(cellPxToSubFactor(1)).toBe(MAX_FOV_SUB_FACTOR);
    });

    it('falls back to the default factor for non-positive / non-finite input', () => {
      expect(cellPxToSubFactor(0)).toBe(DEFAULT_FOV_SUB_FACTOR);
      expect(cellPxToSubFactor(-8)).toBe(DEFAULT_FOV_SUB_FACTOR);
      expect(cellPxToSubFactor(Number.NaN)).toBe(DEFAULT_FOV_SUB_FACTOR);
      expect(cellPxToSubFactor(Number.POSITIVE_INFINITY)).toBe(DEFAULT_FOV_SUB_FACTOR);
    });

    it('honors a custom tile size', () => {
      expect(cellPxToSubFactor(16, 64)).toBe(4);
    });
  });

  describe('presets', () => {
    const presets = Object.keys(FOV_PRESET_CELL_PX) as FovPresetId[];

    it('round-trips every preset cellPx → factor → cellPx', () => {
      for (const preset of presets) {
        const cellPx = getFovPresetCellPx(preset);
        const factor = getFovPresetSubFactor(preset);
        expect(cellPxToSubFactor(cellPx)).toBe(factor);
        expect(subFactorToCellPx(factor)).toBe(cellPx);
      }
    });

    it('maps preset ids to the expected factors', () => {
      expect(getFovPresetSubFactor('tile')).toBe(1);
      expect(getFovPresetSubFactor('halfTile')).toBe(2);
      expect(getFovPresetSubFactor('quarterTile')).toBe(4);
      expect(getFovPresetSubFactor('fine')).toBe(8);
    });

    it('keeps the default preset aligned with the default factor', () => {
      expect(getFovPresetSubFactor(DEFAULT_FOV_PRESET)).toBe(DEFAULT_FOV_SUB_FACTOR);
    });
  });
});
