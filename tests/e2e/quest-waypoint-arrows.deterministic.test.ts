import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { QuestWaypointProbeApi } from '../../src/labs/questwaypoints-lab/index.js';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
} from '../../src/shared/quest-types.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=questwaypoints-lab`;

describe('quest waypoint arrows deterministic guard', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForFunction(
      () =>
        Boolean((window as { __questWaypointProbe?: QuestWaypointProbeApi }).__questWaypointProbe),
      undefined,
      { timeout: 30_000 },
    );
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('renders one visible arrow for every active targeted quest', async () => {
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as { __questWaypointProbe?: QuestWaypointProbeApi }
            ).__questWaypointProbe?.visibleQuestIds() ?? [],
        ),
      )
      .toEqual([FLOOR1_FIND_WELCOME_QUEST_ID, FLOOR1_SHOP_QUEST_ID, FLOOR1_BOSS_BATTLE_QUEST_ID]);
  });
});
