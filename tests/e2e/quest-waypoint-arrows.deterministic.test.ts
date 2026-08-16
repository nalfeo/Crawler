import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
} from '../../src/shared/quest-types.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';
import { closeQuietly } from './helpers/ui-probe.js';

describe('quest waypoint arrows deterministic guard', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await loadMainSceneProbeLab(page);
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('omits arrows that cannot avoid reserved HUD regions in MainGameScene', async () => {
    await mainSceneProbe.primeQuestWaypointArrows(page);
    await expect
      .poll(() => mainSceneProbe.getVisibleQuestArrowIds(page))
      .toEqual([FLOOR1_BOSS_BATTLE_QUEST_ID]);
  });

  it('keeps crowded down-right arrows separated on the lower half of the rendered right edge', async () => {
    await mainSceneProbe.primeCrowdedDownRightQuestWaypointArrows(page);
    await expect
      .poll(() =>
        mainSceneProbe
          .getVisibleQuestArrowStates(page)
          .then((arrows) => arrows.map(({ questId }) => questId).sort()),
      )
      .toEqual([FLOOR1_BOSS_BATTLE_QUEST_ID, FLOOR1_FIND_WELCOME_QUEST_ID, FLOOR1_SHOP_QUEST_ID]);

    const arrows = await mainSceneProbe.getVisibleQuestArrowStates(page);
    const targetOffsets = new Map([
      [FLOOR1_FIND_WELCOME_QUEST_ID, { x: 100, y: 30 }],
      [FLOOR1_SHOP_QUEST_ID, { x: 101, y: 30 }],
      [FLOOR1_BOSS_BATTLE_QUEST_ID, { x: 102, y: 30 }],
    ]);
    for (const [index, arrow] of arrows.entries()) {
      const target = targetOffsets.get(arrow.questId)!;
      expect(arrow.x).toBeCloseTo(1184, 0);
      expect(arrow.y).toBeGreaterThanOrEqual(360);
      expect(arrow.rotation).toBeCloseTo(Math.atan2(target.y, target.x) + Math.PI / 2);
      for (const other of arrows.slice(index + 1)) {
        expect(Math.hypot(arrow.x - other.x, arrow.y - other.y)).toBeGreaterThanOrEqual(48);
      }
    }
  });
});
