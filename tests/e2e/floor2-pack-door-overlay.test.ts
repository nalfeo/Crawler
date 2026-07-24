import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('Floor 2 terrain-pack door overlay guard', () => {
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

  it('renders closed floor2 doors from industrial-cave doorSet textures in MainGameScene', async () => {
    await loadMainSceneProbeLab(page, { floor: 'floor2' });

    let summary = await mainSceneProbe.getDoorRenderSummary(page);
    const deadline = Date.now() + 5_000;
    while (summary.renderableClosedCount === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
      summary = await mainSceneProbe.getDoorRenderSummary(page);
    }

    expect(
      summary.renderableClosedCount,
      `booted Floor 2 should have at least one closed wall-flanked door to render; summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);
    expect(summary.closedPackCount).toBe(summary.renderableClosedCount);
    expect(summary.closedGeneratedCount + summary.closedKenneyCount + summary.closedColorCount).toBe(0);
  });
});
