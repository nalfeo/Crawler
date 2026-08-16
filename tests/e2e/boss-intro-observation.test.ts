/**
 * Boss-battle introduction observation guard (repo rule #9: observe before done).
 *
 * Boots the REAL `MainGameScene` through the shipped floor bootstrap (the
 * `main-scene-probe-lab` harness — NOT the boss-intro lab, which cannot prove
 * the game wires this up), starts the real Floor-1 staircase boss encounter,
 * and asserts the player-visible contract:
 *
 *   1. No sheet before the battle starts, and the simulation clock advances.
 *   2. The scene opens The Director's lore sheet for that boss on its own,
 *      from its own update loop — the test never opens any UI.
 *   3. The simulation is FROZEN while the sheet is up (world clock does not
 *      advance), i.e. the game is genuinely paused, not merely covered.
 *   4. Every text/portrait box stays inside the FIXED-size sheet frame, and the
 *      flavour viewport never overlaps the dismiss prompt (an early draft
 *      clipped its last paragraph through the footer — this promotes that
 *      visual-bug class into a deterministic check). Copy too long for the
 *      viewport scrolls inside it instead of resizing the sheet.
 *   5. Dismissing resumes the run, and the intro does not fire a second time
 *      for the same boss.
 *
 * Deterministic: the lab boots with a fixed world seed and every assertion is
 * a monotonic comparison of the sim clock — no pixel diffing, no LLM judging.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

/** Poll until the real scene reports the sheet open (it opens from update()). */
async function waitForBossIntroOpen(page: Page): Promise<void> {
  await page.waitForFunction(
    () => window.__mainSceneProbe!.getBossIntroState().open === true,
    undefined,
    { timeout: 15_000, polling: 100 },
  );
}

describe('boss battle introduction in the real game scene', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    await loadMainSceneProbeLab(page);
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('pauses the game behind the lore sheet when a boss battle starts, and resumes on dismiss', async () => {
    // 1. BEFORE — resolve the opening loadout modal (it owns the screen and
    // freezes the sim), then let the run play: no sheet, clock advancing.
    await mainSceneProbe.resolveLoadout(page);
    const before = await mainSceneProbe.getBossIntroState(page);
    expect(before.open).toBe(false);
    expect(before.introId).toBeNull();

    await mainSceneProbe.setSimulationPaused(page, false);
    await page.waitForTimeout(400);
    const running = await mainSceneProbe.getBossIntroState(page);
    expect(running.worldElapsedMs).toBeGreaterThan(before.worldElapsedMs);

    // 2. AFTER — start the real encounter; the SCENE opens the sheet itself.
    await mainSceneProbe.startStaircaseBossBattle(page);
    await waitForBossIntroOpen(page);
    const shown = await mainSceneProbe.getBossIntroState(page);
    expect(shown.introId).toBe('floor1:staircase');

    // 3. FROZEN — the sim clock must not advance while the sheet is up.
    await page.waitForTimeout(500);
    const stillShown = await mainSceneProbe.getBossIntroState(page);
    expect(stillShown.open).toBe(true);
    expect(stillShown.worldElapsedMs).toBe(shown.worldElapsedMs);

    // 4. LAYOUT — nothing escapes the sheet, nothing collides with the footer.
    const layout = stillShown.layout;
    expect(layout).not.toBeNull();
    const panel = layout!.panel;
    for (const [label, box] of Object.entries(layout!)) {
      if (label === 'panel') continue;
      expect(
        box.x >= panel.x &&
          box.y >= panel.y &&
          box.x + box.width <= panel.x + panel.width &&
          box.y + box.height <= panel.y + panel.height,
        `${label} escapes the sheet: ${JSON.stringify(box)} vs ${JSON.stringify(panel)}`,
      ).toBe(true);
    }
    expect(layout!.flavor.y + layout!.flavor.height).toBeLessThanOrEqual(layout!.footer.y);

    // 4b. FIXED SIZE — the sheet is the same box for every boss, and long copy
    // scrolls in place rather than growing the frame.
    expect(panel.width).toBe(680);
    expect(panel.height).toBe(340);

    const scroll = stillShown.scroll;
    expect(scroll).not.toBeNull();
    expect(scroll!.visibleLines).toBeGreaterThanOrEqual(1);
    expect(scroll!.index).toBe(0);
    if (scroll!.scrollable) {
      await mainSceneProbe.scrollBossIntro(page, 1);
      const scrolled = await mainSceneProbe.getBossIntroState(page);
      expect(scrolled.scroll!.index).toBe(1);
      expect(scrolled.layout!.panel.height).toBe(panel.height);
      await mainSceneProbe.scrollBossIntro(page, 9999);
      const bottomed = await mainSceneProbe.getBossIntroState(page);
      expect(bottomed.scroll!.index).toBe(bottomed.scroll!.maxIndex);
      await mainSceneProbe.scrollBossIntro(page, -9999);
      expect((await mainSceneProbe.getBossIntroState(page)).scroll!.index).toBe(0);
    } else {
      await mainSceneProbe.scrollBossIntro(page, 1);
      expect((await mainSceneProbe.getBossIntroState(page)).scroll!.index).toBe(0);
    }

    // 5. RESUME — dismissing closes the sheet and the sim runs again.
    await mainSceneProbe.dismissBossIntro(page);
    await page.waitForTimeout(400);
    const resumed = await mainSceneProbe.getBossIntroState(page);
    expect(resumed.open).toBe(false);
    expect(resumed.worldElapsedMs).toBeGreaterThan(stillShown.worldElapsedMs);

    // 6. ONCE ONLY — the same boss never re-introduces itself mid-fight.
    await page.waitForTimeout(400);
    expect((await mainSceneProbe.getBossIntroState(page)).open).toBe(false);
  }, 90_000);
});
