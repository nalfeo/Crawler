/**
 * Deterministic real-scene observation for #4140. The real MainGameScene is
 * booted through its shipped bootstrap and receives the lethal axe event pair
 * (`hit` followed by its gameplay `death` signal) on its normal combat-event
 * queue. The presentation contract is exactly one visible damage floater.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('axe lethal-hit combat feedback (real scene)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await mainSceneProbe.setSimulationPaused(page, true);
  }, 180_000);

  afterAll(async () => {
    await closeQuietly(page);
    await closeQuietly(context);
    await closeQuietly(browser);
  });

  it('renders one damage number for the lethal rune-axe hit and death-event pair', async () => {
    await mainSceneProbe.pushTestCombatEvent(page, { type: 'hit', amount: 24 });
    await mainSceneProbe.pushTestCombatEvent(page, { type: 'death', amount: 24 });
    await mainSceneProbe.advanceSimulationFrames(page, 2);

    expect(await mainSceneProbe.getVisibleFloatingTexts(page, '-24')).toHaveLength(1);
  }, 30_000);
});
