import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

describe('MainGameScene material gain floaters', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'loadout resolved + simulation paused',
    });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('renders a material gain floater for a picked-up material drop in the real scene', async () => {
    expect(await mainSceneProbe.getVisibleFloatingTexts(page, '+1 Iron Ore')).toEqual([]);
    expect(await mainSceneProbe.spawnAndPickupFloorDrop(page, 'iron-ore')).toEqual({ ok: true });

    await page.waitForFunction(
      () => (window.__mainSceneProbe?.getVisibleFloatingTexts('+1 Iron Ore').length ?? 0) > 0,
      undefined,
      { timeout: 5_000 },
    );

    expect(await mainSceneProbe.getVisibleFloatingTexts(page, '+1 Iron Ore')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: '+1 Iron Ore',
        }),
      ]),
    );
  }, 30_000);
});
