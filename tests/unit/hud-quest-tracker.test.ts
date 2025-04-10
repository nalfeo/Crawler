import { describe, expect, it } from 'vitest';
import { fitQuestTrackerLines } from '../../src/engine/HudQuestTracker.js';
import {
  boundsOverlap,
  NAV_QUEST_MAX_HEIGHT,
  NAV_QUEST_WIDTH,
  resolveNavigationHudLayout,
} from '../../src/engine/navigation-hud-layout.js';

describe('fitQuestTrackerLines', () => {
  it('wraps long objectives within the fixed character budget', () => {
    const lines = fitQuestTrackerLines([
      '  [ ] Return the disgusting Rat Tail to the merchant before leaving the dungeon floor',
    ]);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 39)).toBe(true);
  });

  it('hard-splits a single token that exceeds the 32-character budget', () => {
    const token = 'AVERYLONGTOKENTHATEXCEEDSTHIRTYTWOCHARSANDKEEPSGOING';
    const lines = fitQuestTrackerLines([token]);

    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length <= 32)).toBe(true);
  });

  it('hard-splits an overlong first token on an indented line', () => {
    const longWord = 'SUPERLONGWORDEXCEEDINGBUDGETCOMPLETELY';
    const lines = fitQuestTrackerLines([`  ${longWord}`]);

    expect(lines.every((line) => line.length <= 32)).toBe(true);
    // No line should exceed the 32-char budget.
  });

  it('caps crowded quest content and marks the truncation', () => {
    const lines = fitQuestTrackerLines(
      Array.from({ length: 12 }, (_, index) => `Quest objective ${index} with a long description`),
    );

    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toMatch(/\.\.\.$/);
  });
});

describe('responsive quest tracker layout', () => {
  for (const viewport of [
    { name: '1280x720 primary', uiScale: 1 },
    { name: '960x540 secondary', uiScale: 4 / 3 },
  ]) {
    it(`keeps the maximum tracker clear of the radar at ${viewport.name}`, () => {
      const layout = resolveNavigationHudLayout(viewport.uiScale, 1);
      const tracker = {
        x: layout.questPosition.x,
        y: layout.questPosition.y,
        width: NAV_QUEST_WIDTH * layout.questScale,
        height: NAV_QUEST_MAX_HEIGHT * layout.questScale,
      };

      expect(boundsOverlap(tracker, layout.radarBounds)).toBe(false);
      expect(tracker.x).toBeGreaterThanOrEqual(0);
      expect(tracker.y).toBeGreaterThanOrEqual(0);
      expect(tracker.x + tracker.width).toBeLessThanOrEqual(1280);
      expect(tracker.y + tracker.height).toBeLessThanOrEqual(720);
    });

    it(`keeps the Floor 2 tracker clear of the family reservation at ${viewport.name}`, () => {
      const layout = resolveNavigationHudLayout(viewport.uiScale, 2);
      const tracker = {
        x: layout.questPosition.x,
        y: layout.questPosition.y,
        width: NAV_QUEST_WIDTH * layout.questScale,
        height: NAV_QUEST_MAX_HEIGHT * layout.questScale,
      };
      const familyReservation = layout.criticalHudRegions.at(-1)!;
      const topCenterReservation = layout.criticalHudRegions[0]!;

      expect(layout.questPosition.x).toBe(16);
      expect(layout.questPosition.y).toBeGreaterThan(
        topCenterReservation.y + topCenterReservation.height,
      );
      expect(boundsOverlap(tracker, layout.radarBounds)).toBe(false);
      expect(boundsOverlap(tracker, topCenterReservation)).toBe(false);
      expect(boundsOverlap(tracker, familyReservation)).toBe(false);
    });
  }
});
