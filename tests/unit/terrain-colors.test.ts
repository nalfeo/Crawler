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

  it('keeps explicit fallback colors for unmapped placeholder terrains', () => {
    expect(TERRAIN_FALLBACK_COLORS[TerrainType.LAVA]).toBe(0xb91c1c);
    expect(TERRAIN_FALLBACK_COLORS[TerrainType.DIRT]).toBe(0x6b3f24);
    expect(TERRAIN_FALLBACK_COLORS[TerrainType.WOOD_FLOOR]).toBe(0x5b4430);
  });

  it('uses the updated cave floor and wall fallback colors', () => {
    expect(TERRAIN_FALLBACK_COLORS[TerrainType.CAVE_FLOOR]).toBe(0x6b4a2e);
    expect(TERRAIN_FALLBACK_COLORS[TerrainType.CAVE_WALL]).toBe(0x2c1a16);
  });
});
