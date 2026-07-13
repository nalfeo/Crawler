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

  it('hard-splits a token too long to fit even on an empty line', () => {
    // 36-char word, MAX_LINE_CHARS=32 → must be split, no line may exceed 32 chars
    const longWord = 'A'.repeat(36);
    const lines = fitQuestTrackerLines([longWord]);
    expect(lines.every((line) => line.length <= 32)).toBe(true);
    expect(lines.join('')).toContain('A'.repeat(32)); // first chunk present
  });

  it('hard-splits a continuation word that overflows the indented budget', () => {
    // Indent of 4 chars + 30-char word = 34 > 32 → must be split on continuation
    const indent = '    ';
    const longWord = 'B'.repeat(30);
    const lines = fitQuestTrackerLines([`${indent}short ${longWord}`]);
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

    it(`keeps the Floor 2 tracker clear of all critical HUD regions at ${viewport.name}`, () => {
      const layout = resolveNavigationHudLayout(viewport.uiScale, 2);
      const tracker = {
        x: layout.questPosition.x,
        y: layout.questPosition.y,
        width: NAV_QUEST_WIDTH * layout.questScale,
        height: NAV_QUEST_MAX_HEIGHT,
      };

      expect(tracker.x).toBe(16);
      // y must be derived from the scaled top-center band, not hardcoded
      expect(tracker.y).toBeGreaterThan(0);
      expect(boundsOverlap(tracker, layout.radarBounds)).toBe(false);
      // Assert clearance from every critical region (topCenter, bottomLeft, bottomCenter, familyPanel)
      for (const region of layout.criticalHudRegions) {
        expect(boundsOverlap(tracker, region)).toBe(false);
      }
    });
  }
});
