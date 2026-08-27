/**
 * Carried main-hand weapon guard (rule #9 "observe before done", deterministic).
 *
 * The persistent carried-weapon sprite in `PhaserBridge` is feature-flagged and
 * currently disabled by default, so players should render empty-handed outside
 * attack-time weapon effects unless/until the flag is re-enabled.
 *
 * A lab cannot prove this: the question is whether the REAL scene's render
 * bridge draws the weapon during ordinary idle frames. So this suite boots the
 * real `MainGameScene` through the shipped floor bootstrap (the probe lab) and
 * asserts against the live display list that:
 *
 *   1. a melee main-hand weapon does NOT render a persistent carried sprite
 *      while the player is idle (default-off behavior);
 *   2. switching to a ranged weapon also keeps the carried sprite hidden.
 *
 * Determinism: the probe lab boots with a fixed world seed and the weapon is
 * equipped explicitly by id; every assertion is on display-list state, never on
 * pixels or wall clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

/** Wait for the render bridge to run at least one more sync pass. */
async function nextRenderedFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

describe('carried main-hand weapon default-off behavior in the real booted scene', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
    await loadMainSceneProbeLab(page);
    await waitForState(page, (state) => state.hudPresent && state.bridgePresent);
    await mainSceneProbe.resolveLoadout(page);
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('does not render a persistent carried sprite for an equipped melee weapon while idle', async () => {
    expect(await mainSceneProbe.equipMainHandWeapon(page, 'sword')).toBe(true);
    await nextRenderedFrame(page);

    const info = await mainSceneProbe.getCarriedWeaponRenderInfo(page);

    expect(info.activeWeaponId).toBe('sword');
    expect(info.spriteCount).toBe(0);
    expect(info.visible).toBe(false);
    expect(info.textureKey).toBeNull();
  });

  it('drops the carried sprite for a weapon with no carry art', async () => {
    expect(await mainSceneProbe.equipMainHandWeapon(page, 'bow')).toBe(true);
    await nextRenderedFrame(page);

    const info = await mainSceneProbe.getCarriedWeaponRenderInfo(page);

    expect(info.activeWeaponId).toBe('bow');
    expect(info.visible).toBe(false);
  });
});
