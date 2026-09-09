import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';
import { closeQuietly } from './helpers/ui-probe.js';

describe('MainGameScene Floor 4 Green Room shop interaction', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await loadMainSceneProbeLab(page, { floor: 'floor4', seed: 404 });
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (state) => state.worldState === 'playing', {
      label: 'Floor 4 scene playing',
    });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('opens from the Green Room marker and purchases through the shared panel handler', async () => {
    await mainSceneProbe.setPlayerGold(page, 100_000);
    const marker = await mainSceneProbe.primeFloor4GreenRoomIntermission(page);
    expect(marker, 'the authored Green Room marker must exist').not.toBeNull();
    await mainSceneProbe.setSimulationPaused(page, true);

    const before = await mainSceneProbe.getState(page);
    expect(before.floor4Arena?.phase).toEqual({ kind: 'INTERMISSION', act: 1 });
    expect(before.floor4GreenRoom?.stock.length).toBeGreaterThan(0);
    expect(before.quartermasterOpen).toBe(false);

    await mainSceneProbe.advanceSimulationFrames(page, 1);
    await mainSceneProbe.queueInteraction(page);
    await mainSceneProbe.advanceSimulationFrames(page, 1);
    const opened = await waitForState(page, (state) => state.quartermasterOpen, {
      label: 'Green Room shop opened by marker interaction',
    });

    const purchasable = opened.floor4GreenRoom!.stock.find((offer) => offer.quantity > 0);
    expect(
      purchasable,
      'the rendered panel must expose stocked Green Room inventory',
    ).toBeDefined();
    const goldBeforePurchase = opened.floor4GreenRoom!.playerGold;
    const stockBeforePurchase = purchasable!.quantity;
    const inventoryBeforePurchase = opened.floor4GreenRoom!.inventory;

    await page.keyboard.press('Enter');
    const purchased = await waitForState(
      page,
      (state) =>
        (state.floor4GreenRoom?.purchases ?? 0) === (opened.floor4GreenRoom?.purchases ?? 0) + 1,
      { label: 'Green Room panel purchase completed' },
    );

    expect(purchased.floor4GreenRoom!.playerGold).toBeLessThan(goldBeforePurchase);
    expect(purchased.floor4GreenRoom!.spentGold).toBeGreaterThan(0);
    expect(purchased.floor4GreenRoom!.vendorPurchases).toBeGreaterThanOrEqual(1);
    expect(
      purchased.floor4GreenRoom!.stock.find((offer) => offer.offerId === purchasable!.offerId)
        ?.quantity,
    ).toBe(stockBeforePurchase - 1);
    expect(purchased.floor4GreenRoom!.inventory).not.toEqual(inventoryBeforePurchase);
  });
});
