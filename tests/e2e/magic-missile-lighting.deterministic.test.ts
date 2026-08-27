/**
 * Magic Missile lighting observation in the real MainGameScene.
 *
 * The fixed-seed probe boots through the shipped floor bootstrap, activates the
 * real spell, then samples the scene's computed light field at the moving bolt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('Magic Missile projectile lighting (real scene)', () => {
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

  it('adds light while in flight and removes it when the bolt impacts', async () => {
    expect(await mainSceneProbe.primeMagicMissileLightProbe(page)).toBe(true);
    await mainSceneProbe.advanceSimulationFrames(page, 2);
    await page.waitForFunction(
      () => (window.__mainSceneProbe?.getMagicMissileLightProbe().inFlightCount ?? 0) > 0,
      undefined,
      { timeout: 10_000, polling: 100 },
    );

    const inFlight = await mainSceneProbe.getMagicMissileLightProbe(page);
    expect(inFlight.inFlightCount).toBeGreaterThan(0);
    expect(inFlight.emitterLight).not.toBeNull();
    expect(inFlight.emitterLight ?? 0).toBeGreaterThan(0.05);

    await mainSceneProbe.advanceSimulationFrames(page, 60);
    await page.waitForFunction(
      () => (window.__mainSceneProbe?.getMagicMissileLightProbe().inFlightCount ?? 0) === 0,
      undefined,
      { timeout: 10_000, polling: 100 },
    );
    expect((await mainSceneProbe.getMagicMissileLightProbe(page)).emitterLight).toBeNull();
  }, 60_000);
});
