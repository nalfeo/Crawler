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
  }

  it('keeps the 960x540 Floor 2 tracker clear of the family reservation', () => {
    const layout = resolveNavigationHudLayout(4 / 3, 2);
    const tracker = {
      x: layout.questPosition.x,
      y: layout.questPosition.y,
      width: NAV_QUEST_WIDTH * layout.questScale,
      height: NAV_QUEST_MAX_HEIGHT * layout.questScale,
    };
    const familyReservation = layout.criticalHudRegions.at(-1)!;

    expect(boundsOverlap(tracker, layout.radarBounds)).toBe(false);
    expect(boundsOverlap(tracker, familyReservation)).toBe(false);
  });
});
