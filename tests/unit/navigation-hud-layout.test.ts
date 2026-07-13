import { describe, expect, it } from 'vitest';
import {
  boundsOverlap,
  NAV_QUEST_MAX_HEIGHT,
  NAV_QUEST_WIDTH,
  resolveNavigationHudLayout,
} from '../../src/engine/navigation-hud-layout.js';

describe('navigation HUD layout', () => {
  it('stacks the desktop quest tracker below the docked radar', () => {
    const layout = resolveNavigationHudLayout(1, 1);
    const quest = {
      x: layout.questPosition.x,
      y: layout.questPosition.y,
      width: NAV_QUEST_WIDTH * layout.questScale,
      height: NAV_QUEST_MAX_HEIGHT * layout.questScale,
    };

    expect(boundsOverlap(layout.radarBounds, quest)).toBe(false);
    expect(quest.x + quest.width).toBeLessThanOrEqual(1280);
    expect(quest.y + quest.height).toBeLessThanOrEqual(720);
  });

  it('moves the mobile Floor 2 tracker away from the scaled family panel', () => {
    const layout = resolveNavigationHudLayout(1.6, 2);
    const quest = {
      x: layout.questPosition.x,
      y: layout.questPosition.y,
      width: NAV_QUEST_WIDTH * layout.questScale,
      height: NAV_QUEST_MAX_HEIGHT * layout.questScale,
    };
    const familyPanel = {
      x: -768 + 1036 * 1.6,
      y: -432 + 386 * 1.6,
      width: 232 * 1.6,
      height: 174 * 1.6,
    };

    expect(layout.questPosition.x).toBe(16);
    expect(boundsOverlap(quest, familyPanel)).toBe(false);
    expect(boundsOverlap(quest, layout.radarBounds)).toBe(false);
  });
});
