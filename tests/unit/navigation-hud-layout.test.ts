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

  it('stacks the 960x540 Floor 2 tracker below the docked radar', () => {
    const layout = resolveNavigationHudLayout(computeUiScale(960, 540), 2);
    const quest = questBounds(layout);
    expect(computeUiScale(960, 540)).toBe(1.33);
    expect(quest.x + quest.width).toBeLessThanOrEqual(1280);
    expect(quest.y).toBeGreaterThan(layout.radarBounds.y + layout.radarBounds.height);
    expect(boundsOverlap(quest, layout.radarBounds)).toBe(false);
  });
});
