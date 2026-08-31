import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  DEFAULT_PLAYER_GENDER,
  DEFAULT_PLAYER_NAME,
  type PlayerGender,
} from '../../src/shared/intro-config.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import { closeQuietly } from './helpers/ui-probe.js';

type IntroDebugState = {
  renderScale: number;
  cameraZoom: number;
  cameraOriginX: number;
  cameraOriginY: number;
  selectedGender: PlayerGender;
};

type IntroFlowSnapshot = {
  introData: { playerName: string; playerGender: PlayerGender } | null;
  world: { playerName: string; playerGender: PlayerGender; protagonistName: string | null } | null;
  directorText: string | null;
};

type IntroDebugWindow = Window & {
  __introDebug?: {
    getState: () => IntroDebugState;
  };
  __floor1Debug?: {
    getIntroData?: () => { playerName: string; playerGender: PlayerGender } | undefined;
    getDirectorCommentaryText?: () => string | null;
    getWorld?: () => {
      playerName: string;
      playerGender: PlayerGender;
      floorScenario?: { protagonistName?: string | null } | null;
    };
  };
};

async function loadIntro(page: Page): Promise<void> {
  await page.goto(`${E2E_LAB_BASE_URL}/index.html`, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForFunction(
    () => Boolean((window as unknown as IntroDebugWindow).__introDebug?.getState()),
    undefined,
    { timeout: 30_000 },
  );
}

/**
 * Confirm the intro form and prove the IntroScene actually tore down.
 *
 * `IntroScene` focuses the name input from a delayed Phaser timer
 * (`this.time.delayedCall(80, () => input.focus())`), so a confirm keypress
 * dispatched around that window can land on an element that is about to lose
 * focus and never reach the input's `keydown` handler. Waiting for
 * `__introDebug` to disappear (deleted by `IntroScene.handleShutdown`) makes the
 * advance observable instead of silently deferring the failure to the 30s
 * `__floor1Debug` wait, and lets a dropped keypress be retried.
 */
async function confirmIntro(page: Page): Promise<void> {
  const nameInput = page.getByLabel('Player name');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stillOnIntro = await page.evaluate(() =>
      Boolean((window as unknown as IntroDebugWindow).__introDebug),
    );
    if (!stillOnIntro) {
      return;
    }
    await nameInput.press('Enter');
    try {
      await page.waitForFunction(
        () => !(window as unknown as IntroDebugWindow).__introDebug,
        undefined,
        { timeout: 5_000 },
      );
      return;
    } catch {
      // Confirm keypress was dropped; retry on the next iteration.
    }
  }
  throw new Error('IntroScene did not advance to the game scene after confirming the name');
}

async function waitForFloorDebug(page: Page, expectedName: string): Promise<void> {
  await page.waitForFunction(
    (name) => {
      const debug = (window as unknown as IntroDebugWindow).__floor1Debug;
      return (
        Boolean(debug?.getIntroData?.()) &&
        Boolean(debug?.getDirectorCommentaryText?.()?.includes(name as string))
      );
    },
    expectedName,
    // Nominal local runtime is ~10s per intro-flow test; CI can be slower when
    // this suite runs alongside 50+ visual tests, so keep a buffer above 30s.
    { timeout: 45_000 },
  );
}

async function readIntroFlowSnapshot(page: Page): Promise<IntroFlowSnapshot> {
  return page.evaluate(() => {
    const debug = (window as unknown as IntroDebugWindow).__floor1Debug;
    const introData = debug?.getIntroData?.() ?? null;
    const world = debug?.getWorld?.();
    return {
      introData,
      world: world
        ? {
            playerName: world.playerName,
            playerGender: world.playerGender,
            protagonistName: world.floorScenario?.protagonistName ?? null,
          }
        : null,
      directorText: debug?.getDirectorCommentaryText?.() ?? null,
    };
  });
}

describe('IntroScene flow', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1920, height: 1280 } });
  });

  // A fresh page per test: the second test otherwise reuses a document that the
  // first already drove into the game scene, so stale `__floor1Debug`/scene
  // teardown state can race the next intro load.
  beforeEach(async () => {
    page = await context.newPage();
  });

  afterEach(async () => {
    await page.close();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('defaults blank names before handing identity to the real game scene', async () => {
    await loadIntro(page);

    await page.getByLabel('Player name').fill('   ');
    await confirmIntro(page);

    await waitForFloorDebug(page, DEFAULT_PLAYER_NAME);
    const snapshot = await readIntroFlowSnapshot(page);

    expect(snapshot.introData).toEqual({
      playerName: DEFAULT_PLAYER_NAME,
      playerGender: DEFAULT_PLAYER_GENDER,
    });
    expect(snapshot.world).toEqual({
      playerName: DEFAULT_PLAYER_NAME,
      playerGender: DEFAULT_PLAYER_GENDER,
      protagonistName: DEFAULT_PLAYER_NAME,
    });
    expect(snapshot.directorText).toContain(DEFAULT_PLAYER_NAME);
  });

  it('uses render scale 2, trims custom names, and preserves dollar tokens in commentary', async () => {
    await loadIntro(page);

    const introState = await page.evaluate(() =>
      (window as unknown as IntroDebugWindow).__introDebug!.getState(),
    );
    expect(introState.renderScale).toBe(2);
    expect(introState.cameraZoom).toBe(2);
    expect(introState.cameraOriginX).toBe(0);
    expect(introState.cameraOriginY).toBe(0);

    const customName = 'A$&B';
    await page.getByLabel('Player name').fill(`  ${customName}  `);
    await page.getByLabel('They / Them').check();
    await confirmIntro(page);

    await waitForFloorDebug(page, customName);
    const snapshot = await readIntroFlowSnapshot(page);

    expect(snapshot.introData).toEqual({
      playerName: customName,
      playerGender: 'other',
    });
    expect(snapshot.world).toEqual({
      playerName: customName,
      playerGender: 'other',
      protagonistName: customName,
    });
    expect(snapshot.directorText).toContain(customName);
    expect(snapshot.directorText).not.toContain('{playerName}');
  });
});
