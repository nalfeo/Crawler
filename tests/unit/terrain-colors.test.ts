import { describe, expect, it } from 'vitest';
import { TerrainType } from '../../src/shared/map-types.js';
import { colorToCss, TERRAIN_FALLBACK_COLORS } from '../../src/shared/terrain-colors.js';

describe('terrain colors', () => {
  it('defines a fallback color for every terrain enum value', () => {
    const terrainValues = Object.values(TerrainType).filter(
      (value): value is TerrainType => typeof value === 'number',
    );

    for (const terrainType of terrainValues) {
      expect(TERRAIN_FALLBACK_COLORS[terrainType]).toBeTypeOf('number');
    }
  });

  it('converts colors to zero-padded css hex values', () => {
    expect(colorToCss(0x1f2937)).toBe('#1f2937');
    expect(colorToCss(0x5)).toBe('#000005');
  });
});
