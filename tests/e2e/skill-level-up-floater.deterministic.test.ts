import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

describe('MainGameScene skill level-up floaters', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  async function bootPlayingScene(): Promise<void> {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'loadout resolved + simulation paused',
    });
  }

  it('renders +1 skill floaters in the real scene and staggers same-frame multi-level gains', async () => {
    await bootPlayingScene();

    expect(await mainSceneProbe.getVisibleFloatingTexts(page, '+1 ')).toEqual([]);

    await mainSceneProbe.queueSkillUsage(page, 'swordsmanship', 'hits_landed', 260);
    await mainSceneProbe.advanceSimulationFrames(page, 2);
    await page.waitForFunction(
      () => (window.__mainSceneProbe?.getVisibleFloatingTexts('+1 Swordsmanship').length ?? 0) >= 5,
      undefined,
      { timeout: 5_000 },
    );

    const floaters = await mainSceneProbe.getVisibleFloatingTexts(page, '+1 Swordsmanship');
    expect(floaters).toHaveLength(5);
    expect(new Set(floaters.map((floater) => `${floater.x},${floater.y}`)).size).toBe(5);
    expect(floaters.every((floater) => floater.text === '+1 Swordsmanship')).toBe(true);
    for (let i = 1; i < floaters.length; i += 1) {
      expect(floaters[i - 1]!.y).toBeLessThan(floaters[i]!.y);
    }
  }, 30_000);
});
