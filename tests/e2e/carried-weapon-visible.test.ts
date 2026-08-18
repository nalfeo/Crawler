/**
 * Carried main-hand weapon guard (rule #9 "observe before done", deterministic).
 *
 * The player's weapon used to be drawn ONLY while a transient `MeleeSwing`
 * entity existed, so between swings the player rendered empty-handed. The fix
 * adds a persistent carried-weapon sprite in `PhaserBridge`, driven by the
 * active main-hand weapon def.
 *
 * A lab cannot prove this: the question is whether the REAL scene's render
 * bridge draws the weapon during ordinary idle frames. So this suite boots the
 * real `MainGameScene` through the shipped floor bootstrap (the probe lab) and
 * asserts against the live display list that:
 *
 *   1. a melee weapon equipped in the main hand is drawn and visible while the
 *      player is idle (no swing in flight);
 *   2. the sprite sits next to the player (hand offset), not at the origin;
 *   3. switching to a ranged weapon with no carry art removes the sprite rather
 *      than leaving a stale sword in the player's hand.
 *
 * Determinism: the probe lab boots with a fixed world seed and the weapon is
 * equipped explicitly by id; every assertion is on display-list state (texture
 * key / visibility / integer pixel offsets), never on pixels or wall clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';
import { PIXELS_PER_FOOT } from '../../src/shared/units.js';

/** Wait for the render bridge to run at least one more sync pass. */
async function nextRenderedFrame(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

describe('carried main-hand weapon in the real booted scene', () => {
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

  it('renders the equipped melee weapon while the player is idle', async () => {
    expect(await mainSceneProbe.equipMainHandWeapon(page, 'sword')).toBe(true);
    await nextRenderedFrame(page);

    const info = await mainSceneProbe.getCarriedWeaponRenderInfo(page);

    expect(info.activeWeaponId).toBe('sword');
    expect(info.spriteCount).toBe(1);
    expect(info.visible).toBe(true);
    expect(info.textureKey).not.toBeNull();
    // Held beside the player, within arm's reach — never stranded at the origin.
    expect(info.offsetPx).not.toBeNull();
    const offset = info.offsetPx!;
    expect(Math.abs(offset.x)).toBeGreaterThan(0);
    expect(Math.hypot(offset.x, offset.y)).toBeLessThan(PIXELS_PER_FOOT * 3);
    // Drawn at a readable size rather than a 1px speck.
    expect(info.displayWidthPx).toBeGreaterThan(2);
    expect(info.displayHeightPx).toBeGreaterThan(2);
  });

  it('drops the carried sprite for a weapon with no carry art', async () => {
    expect(await mainSceneProbe.equipMainHandWeapon(page, 'bow')).toBe(true);
    await nextRenderedFrame(page);

    const info = await mainSceneProbe.getCarriedWeaponRenderInfo(page);

    expect(info.activeWeaponId).toBe('bow');
    expect(info.visible).toBe(false);
  });
});
