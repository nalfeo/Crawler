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

  it('keeps same-room arrows separated with one shared direction in MainGameScene', async () => {
    await mainSceneProbe.primeSameRoomQuestWaypointArrows(page);
    await expect
      .poll(() =>
        mainSceneProbe
          .getVisibleQuestArrowStates(page)
          .then((arrows) => arrows.map(({ questId }) => questId).sort()),
      )
      .toEqual([FLOOR1_BOSS_BATTLE_QUEST_ID, FLOOR1_FIND_WELCOME_QUEST_ID, FLOOR1_SHOP_QUEST_ID]);
    const arrows = await mainSceneProbe.getVisibleQuestArrowStates(page);
    const sameRoomArrows = arrows.filter(
      ({ questId }) => questId === FLOOR1_FIND_WELCOME_QUEST_ID || questId === FLOOR1_SHOP_QUEST_ID,
    );
    expect(sameRoomArrows).toHaveLength(2);
    expect(sameRoomArrows[0]!.rotation).toBeCloseTo(sameRoomArrows[1]!.rotation);
    for (const [index, arrow] of sameRoomArrows.entries()) {
      expect(arrow.x).toBeCloseTo(1184, 0);
      for (const other of sameRoomArrows.slice(index + 1)) {
        expect(Math.hypot(arrow.x - other.x, arrow.y - other.y)).toBeGreaterThanOrEqual(48);
      }
    }
  });
});
