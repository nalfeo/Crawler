import { describe, expect, it } from 'vitest';
import { fitQuestTrackerLines } from '../../src/engine/HudQuestTracker.js';

describe('fitQuestTrackerLines', () => {
  it('wraps long objectives within the fixed character budget', () => {
    const lines = fitQuestTrackerLines([
      '  [ ] Return the disgusting Rat Tail to the merchant before leaving the dungeon floor',
    ]);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 39)).toBe(true);
  });

  it('caps crowded quest content and marks the truncation', () => {
    const lines = fitQuestTrackerLines(
      Array.from({ length: 12 }, (_, index) => `Quest objective ${index} with a long description`),
    );

    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toMatch(/\.\.\.$/);
  });
});
