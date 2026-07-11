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

  it('renders one visible arrow for every active targeted quest in MainGameScene', async () => {
    await mainSceneProbe.primeQuestWaypointArrows(page);
    await expect
      .poll(() => mainSceneProbe.getVisibleQuestArrowIds(page))
      .toEqual([FLOOR1_FIND_WELCOME_QUEST_ID, FLOOR1_SHOP_QUEST_ID, FLOOR1_BOSS_BATTLE_QUEST_ID]);
  });
});
