import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import {
  FLOOR1_BOSS_BATTLE_QUEST_ID,
  FLOOR1_FIND_WELCOME_QUEST_ID,
  FLOOR1_SHOP_QUEST_ID,
} from '../../src/shared/quest-types.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { GAME_H, GAME_W } from './e2e-constants.js';

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

  it('shows all active merchant and Spell Broker arrows on the main screen and minimap radar', async () => {
    await mainSceneProbe.primeMerchantAndSpellBrokerQuestArrows(page);

    await expect
      .poll(() => mainSceneProbe.getVisibleQuestArrowIds(page).then((ids) => ids.sort()))
      .toEqual([FLOOR1_BOSS_BATTLE_QUEST_ID, FLOOR1_SHOP_QUEST_ID]);
    await expect
      .poll(() => mainSceneProbe.getMinimapRadarWaypointArrowIds(page).then((ids) => ids.sort()))
      .toEqual([FLOOR1_BOSS_BATTLE_QUEST_ID, FLOOR1_SHOP_QUEST_ID]);
  });

  it('shows merchant and Spell Broker quest waypoints as full-screen overlay in-view dots, then as overlay edge arrows once zoomed past them', async () => {
    await mainSceneProbe.primeMerchantAndSpellBrokerQuestArrows(page);
    await page.keyboard.press('m');

    // The overlay opens at fit-zoom, showing the whole floor: both waypoints
    // are inside the current viewport, so `drawDots` renders them as in-view
    // dots and `drawOverlayArrows` skips them (see the `isInsideViewport`
    // guard in HudMinimap.ts). Assert the in-view-dot path directly (not just
    // the edge-arrow accessor's absence) so a regression that silently drops
    // a non-tracked quest's dot cannot hide behind an empty arrow list.
    await expect
      .poll(() => mainSceneProbe.getMinimapOverlayWaypointDotIds(page).then((ids) => ids.sort()))
      .toEqual([FLOOR1_BOSS_BATTLE_QUEST_ID, FLOOR1_SHOP_QUEST_ID]);
    await expect.poll(() => mainSceneProbe.getMinimapOverlayWaypointArrowIds(page)).toEqual([]);

    // Zoom in on the overlay's center until both waypoints fall outside its
    // viewport, forcing the overlay edge-arrow path (previously tracked-quest
    // only) to draw both quests, and the in-view dots to disappear.
    const canvasRect = await page.locator('#lab-canvas canvas').boundingBox();
    expect(canvasRect).not.toBeNull();
    const centerX = canvasRect!.x + (GAME_W / 2) * (canvasRect!.width / GAME_W);
    const centerY = canvasRect!.y + (GAME_H / 2) * (canvasRect!.height / GAME_H);
    await page.mouse.move(centerX, centerY);
    let overlayArrowIds: string[] = [];
    for (let i = 0; i < 20 && overlayArrowIds.length < 2; i += 1) {
      await page.mouse.wheel(0, -240);
      overlayArrowIds = await mainSceneProbe.getMinimapOverlayWaypointArrowIds(page);
    }
    expect(overlayArrowIds.sort()).toEqual([FLOOR1_BOSS_BATTLE_QUEST_ID, FLOOR1_SHOP_QUEST_ID]);
    expect(await mainSceneProbe.getMinimapOverlayWaypointDotIds(page)).toEqual([]);

    await page.keyboard.press('Escape');
  });
});
