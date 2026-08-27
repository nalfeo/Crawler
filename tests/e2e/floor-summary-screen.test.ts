/**
 * Between-floor stats/summary screen — deterministic observation of the REAL
 * scene (issue #3678).
 *
 * Before this feature, clearing a floor showed three lines of flavor copy and
 * auto-advanced after ~1.45s, so a player never saw what the floor cost them.
 * This spec boots the shipped Floor 1 scene through the probe lab, takes the
 * real stairs, and asserts the summary the player reads — then proves the
 * descent only happens once the player acknowledges it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

describe('Between-floor summary screen', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('shows the floor stats and waits for the player before descending', async () => {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await mainSceneProbe.primeFloor1StairTransition(page);

    await mainSceneProbe.queueInteraction(page);
    await waitForState(page, (s) => s.modalOpen, { label: 'descend confirmation modal' });
    await page.keyboard.press('Enter');

    await expect
      .poll(async () => (await mainSceneProbe.getFloorSummaryState(page)).awaitingAcknowledgement, {
        timeout: 10_000,
        interval: 100,
      })
      .toBe(true);

    const summary = await mainSceneProbe.getFloorSummaryState(page);
    expect(summary.visible).toBe(true);
    expect(summary.prompt).toBe('Press SPACE or ENTER to descend');
    const labels = summary.lines.map((line) => line.split('  ')[0]?.trim());
    expect(labels).toEqual(
      expect.arrayContaining(['Time on floor', 'Enemies slain', 'Level', 'Gold']),
    );

    // Deterministic layout guard: every line of completion copy must sit
    // inside the panel, so growing the summary can never overflow it.
    const panel = summary.panelBounds;
    const content = summary.contentBounds;
    expect(panel).not.toBeNull();
    expect(content).not.toBeNull();
    expect(content!.x).toBeGreaterThanOrEqual(panel!.x);
    expect(content!.y).toBeGreaterThanOrEqual(panel!.y);
    expect(content!.x + content!.width).toBeLessThanOrEqual(panel!.x + panel!.width);
    expect(content!.y + content!.height).toBeLessThanOrEqual(panel!.y + panel!.height);

    // The screen must NOT auto-advance for a human: after well past the old
    // ~1.45s auto-transition it is still on Floor 1, still waiting.
    await page.waitForTimeout(3_000);
    const stillWaiting = await mainSceneProbe.getFloorSummaryState(page);
    expect(stillWaiting.awaitingAcknowledgement).toBe(true);
    expect((await mainSceneProbe.getState(page)).floorId).toBe('floor1');

    await page.keyboard.press('Space');
    await waitForState(page, (s) => s.settlementRoomCount > 0 && s.displayObjectCount > 0, {
      timeoutMs: 20_000,
      label: 'Floor 2 scene after acknowledged summary',
    });
    expect(new URL(page.url()).searchParams.get('floor')).toBe('floor2');
  });
});
