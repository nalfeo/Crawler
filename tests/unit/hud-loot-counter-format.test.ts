import { describe, expect, it } from 'vitest';
import { formatCompactLootValue } from '../../src/engine/hud-loot-format.js';

describe('formatCompactLootValue', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1_000, '1K'],
    [9_999, '10K'],
    [999_499, '999K'],
    [999_500, '1.0M'],
    [9_949_999, '9.9M'],
    [9_950_000, '10M'],
    [99_499_999, '99M'],
    [99_500_000, '99M'],
    [Number.MAX_SAFE_INTEGER, '99M'],
  ])('formats %d within the four-glyph loot value budget', (value, expected) => {
    expect(formatCompactLootValue(value)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    'normalizes invalid value %s to zero',
    (value) => {
      expect(formatCompactLootValue(value)).toBe('0');
    },
  );
});
