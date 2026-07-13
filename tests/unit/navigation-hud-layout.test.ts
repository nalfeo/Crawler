import { describe, expect, it } from 'vitest';
import {
  boundsOverlap,
  NAV_QUEST_MAX_HEIGHT,
  NAV_QUEST_WIDTH,
  resolveNavigationHudLayout,
} from '../../src/engine/navigation-hud-layout.js';
import { computeUiScale } from '../../src/engine/ui-scale.js';

function questBounds(layout: ReturnType<typeof resolveNavigationHudLayout>) {
  return {
    x: layout.questPosition.x,
    y: layout.questPosition.y,
    width: NAV_QUEST_WIDTH * layout.questScale,
    height: NAV_QUEST_MAX_HEIGHT * layout.questScale,
  };
}

describe('navigation HUD layout', () => {
  it('keeps the 1280x720 Floor 2 tracker clear of radar and family reservations', () => {
    const layout = resolveNavigationHudLayout(1, 2);
    const quest = questBounds(layout);
    const familyPanel = layout.criticalHudRegions.at(-1)!;

    expect(computeUiScale(1280, 720)).toBe(1);
    expect(boundsOverlap(layout.radarBounds, quest)).toBe(false);
    expect(boundsOverlap(quest, familyPanel)).toBe(false);
    expect(quest.x + quest.width).toBeLessThanOrEqual(1280);
    expect(quest.y + quest.height).toBeLessThanOrEqual(720);
  });

  it('keeps the 960x540 Floor 2 tracker clear of radar and family reservations', () => {
    const uiScale = 4 / 3;
    const layout = resolveNavigationHudLayout(uiScale, 2);
    const quest = questBounds(layout);
    const familyPanel = layout.criticalHudRegions.at(-1)!;

    expect(computeUiScale(960, 540)).toBeCloseTo(uiScale, 2);
    expect(layout.questPosition.x).toBe(16);
    expect(boundsOverlap(quest, familyPanel)).toBe(false);
    expect(boundsOverlap(quest, layout.radarBounds)).toBe(false);
  });
});
