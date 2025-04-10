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
  it('stacks the 1280x720 quest tracker below the docked radar', () => {
    const layout = resolveNavigationHudLayout(computeUiScale(1280, 720), 1);
    const quest = questBounds(layout);

    expect(boundsOverlap(layout.radarBounds, quest)).toBe(false);
    expect(quest.x + quest.width).toBeLessThanOrEqual(1280);
    expect(quest.y + quest.height).toBeLessThanOrEqual(720);
  });

  it('keeps the 960x540 Floor 2 tracker clear of radar and family reservations', () => {
    const layout = resolveNavigationHudLayout(computeUiScale(960, 540), 2);
    const quest = questBounds(layout);
    const topCenter = layout.criticalHudRegions[0]!;
    const familyPanel = layout.criticalHudRegions.at(-1)!;

    expect(computeUiScale(960, 540)).toBe(1.33);
    expect(layout.questPosition.x).toBe(16);
    expect(layout.questPosition.y).toBeGreaterThan(topCenter.y + topCenter.height);
    expect(layout.questScale).toBeLessThanOrEqual(1.27);
    expect(boundsOverlap(quest, topCenter)).toBe(false);
    expect(boundsOverlap(quest, familyPanel)).toBe(false);
    expect(boundsOverlap(quest, layout.radarBounds)).toBe(false);
  });
});
