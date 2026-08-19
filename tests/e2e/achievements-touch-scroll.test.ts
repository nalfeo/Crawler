import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

interface CdpSession {
  send(method: string, params: unknown): Promise<unknown>;
  detach(): Promise<void>;
}

async function dragTouch(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const context = page.context() as BrowserContext & {
    newCDPSession(page: Page): Promise<CdpSession>;
  };
  const session = await context.newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.x, y: from.y, id: 1 }],
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: to.x, y: to.y, id: 1 }],
    });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
}

describe('Achievements touch scrolling', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      hasTouch: true,
      viewport: { width: 1280, height: 720 },
    });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('scrolls Awards with a touch drag without moving the player', async () => {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await mainSceneProbe.unlockSafeRoomSurfaces(page);
    for (const id of [
      'first-bonk',
      'slime-no-more',
      'rat-retired',
      'triple-swipe',
      'five-chain',
      'ten-chain',
    ]) {
      await mainSceneProbe.unlockAchievement(page, id);
    }
    await mainSceneProbe.requestAchievementsToggle(page);
    const opened = await waitForState(page, (state) => state.achievementsOpen, {
      label: 'Awards panel open',
    });
    expect(opened.achievementsScrollIndex).toBe(0);
    expect(opened.playerFeet).not.toBeNull();

    await dragTouch(page, { x: 640, y: 580 }, { x: 640, y: 280 });

    const scrolled = await waitForState(page, (state) => state.achievementsScrollIndex > 0, {
      label: 'Awards panel scrolled by touch',
    });
    expect(scrolled.playerFeet).toEqual(opened.playerFeet);
  });
});
