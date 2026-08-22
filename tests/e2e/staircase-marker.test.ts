/**
 * Floor-exit staircase marker — generated-art wiring guard.
 *
 * The objective marker used to be a plain filled `Arc` (a circle) with no art
 * at all. This guard boots the REAL scene, arranges the unlocked Floor 1
 * staircase (`primeFloor1StairTransition`), and proves the marker actually
 * stamps the approved `the-stairs` generated sprite rather than only the
 * circle fallback — the exact regression this issue closes.
 *
 * Mirrors the existing lab-probe e2e pattern (see `main-game-scene-boot.test.ts`
 * and `tests/e2e/helpers/main-scene-probe.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

describe('Floor-exit staircase marker', () => {
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

  it('stamps the approved generated stairs art, not just the circle fallback', async () => {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await mainSceneProbe.primeFloor1StairTransition(page);

    // primeFloor1StairTransition() spawns+unlocks the staircase and moves the
    // player onto it; wait for the render pass this depends on to settle.
    await waitForState(page, (s) => s.displayObjectCount > 0);

    const info = await mainSceneProbe.getStaircaseMarkerRenderInfo(page);
    expect(info.usesGeneratedArt).toBe(true);
    expect(info.visible).toBe(true);
  });
});
