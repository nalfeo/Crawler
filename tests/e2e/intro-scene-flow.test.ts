import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    { timeout: 30_000 },
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
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('defaults blank names before handing identity to the real game scene', async () => {
    await loadIntro(page);

    const nameInput = page.getByLabel('Player name');
    await nameInput.fill('   ');
    await nameInput.press('Enter');

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
    const nameInput = page.getByLabel('Player name');
    await nameInput.fill(`  ${customName}  `);
    await page.getByLabel('They / Them').check();
    await nameInput.press('Enter');

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
