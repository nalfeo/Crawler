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
    expect(lines.every((line) => line.length <= 32)).toBe(true);
  });

  it('caps crowded quest content and marks the truncation', () => {
    const lines = fitQuestTrackerLines(
      Array.from({ length: 12 }, (_, index) => `Quest objective ${index} with a long description`),
    );

    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toMatch(/\.\.\.$/);
  });

  it('hard-splits a token longer than the line budget so no line overflows', () => {
    const overlong = 'A'.repeat(40);
    const lines = fitQuestTrackerLines([`  ☐ ${overlong}`]);

    expect(lines.every((line) => line.length <= 32)).toBe(true);
  });

  it('bounds continuation lines when an indented token exceeds the remaining budget', () => {
    // Indent is "  " (2 spaces) so continuation indent is "    " (4 spaces).
    // A 30-char word on a continuation line must not produce a 34-char line.
    const wordOf30 = 'B'.repeat(30);
    const lines = fitQuestTrackerLines([`Short ☐ ${wordOf30}`]);

    expect(lines.every((line) => line.length <= 32)).toBe(true);
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

    it(`keeps the Floor 2 tracker clear of every critical region at ${viewport.name}`, () => {
      const layout = resolveNavigationHudLayout(viewport.uiScale, 2);
      const tracker = {
        x: layout.questPosition.x,
        y: layout.questPosition.y,
        width: NAV_QUEST_WIDTH * layout.questScale,
        // Use the layout-provided max height (clamped to clear the bottom-left band).
        height: layout.questMaxHeight * layout.questScale,
      };

      // x=16, left navigation lane.
      expect(layout.questPosition.x).toBe(16);
      expect(boundsOverlap(tracker, layout.radarBounds)).toBe(false);
      for (const region of layout.criticalHudRegions) {
        expect(boundsOverlap(tracker, region)).toBe(false);
      }
    });
  }
});
