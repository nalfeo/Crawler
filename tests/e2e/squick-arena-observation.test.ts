import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`;
const DELTA_MS = 1000 / 60;
const EXPECTED_ANNOUNCEMENT = 'UNDERCITY MOB CALL — The guild always collects!';
const TELEGRAPH_FRAME = 660;
const FIRST_RESOLUTION_FRAME = 750;
const SECOND_RESOLUTION_FRAME = 1500;

interface SquickArenaScene {
  readonly playerEid: number;
  settings: {
    roomPresetId: string;
    floorFilter: string;
    enemyPresetId: string;
    playerMode: string;
    simSpeed: number;
  };
  respawn(): void;
  update(time: number, delta: number): void;
  world: {
    state: string;
    frameCount: number;
    elapsedMs: number;
    announcements: Array<{ kind: string; text?: string }>;
    mobAbilities?: {
      cues?: unknown[];
      byEntity?: Map<
        number,
        { resolvedCasts: number; ownedEntityGenerations?: Map<number, number> }
      >;
    };
  };
}

async function loadArenaLab(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__arenaReady), undefined, {
    timeout: 30_000,
    polling: 200,
  });
}

async function configureSquickArena(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: SquickArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing');
    window.__arenaReady = false;
    scene.settings.roomPresetId = 'boss-arena';
    scene.settings.floorFilter = 'floor2';
    scene.settings.enemyPresetId = 'f2-squick';
    scene.settings.playerMode = 'observer';
    scene.settings.simSpeed = 1;
    scene.respawn();
  });
  await page.waitForFunction(
    () => {
      const scene = (window as unknown as { __arenaScene?: SquickArenaScene }).__arenaScene;
      return Boolean(window.__arenaReady) && scene?.settings?.enemyPresetId === 'f2-squick';
    },
    undefined,
    { timeout: 30_000, polling: 200 },
  );
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: SquickArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing after respawn');
    scene.world.state = 'paused';
  });
}

async function stepToFrame(page: Page, targetFrame: number) {
  return page.evaluate(
    ({ targetFrame, deltaMs }) => {
      const scene = (window as unknown as { __arenaScene?: SquickArenaScene }).__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing');
      if (scene.world.frameCount > targetFrame) {
        throw new Error(`scene already at frame ${scene.world.frameCount}, target ${targetFrame}`);
      }
      scene.world.state = 'playing';
      for (let i = scene.world.frameCount; i < targetFrame; i += 1) {
        scene.update(0, deltaMs);
      }
      scene.world.state = 'paused';
      const cueCount = scene.world.mobAbilities?.cues?.length ?? 0;
      const announcement =
        scene.world.announcements.find((event) => event.kind === 'bossAbilityCast')?.text ?? null;
      const casterInst = [...(scene.world.mobAbilities?.byEntity?.values?.() ?? [])][0];
      const resolvedCasts = casterInst?.resolvedCasts ?? 0;
      const ownedMinions = casterInst?.ownedEntityGenerations?.size ?? 0;
      return {
        frame: scene.world.frameCount,
        elapsedMs: scene.world.elapsedMs,
        cueCount,
        announcement,
        resolvedCasts,
        ownedMinions,
      };
    },
    { targetFrame, deltaMs: DELTA_MS },
  );
}

describe('Squick arena observation', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: GAME_W, height: GAME_H } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('observes telegraph and two-cast cap behavior in the live combat arena', async () => {
    await loadArenaLab(page);
    await configureSquickArena(page);

    const before = await stepToFrame(page, TELEGRAPH_FRAME - 1);
    expect(before.cueCount).toBe(0);
    expect(before.announcement).toBeNull();

    const telegraph = await stepToFrame(page, TELEGRAPH_FRAME);
    expect(telegraph.cueCount).toBe(1);
    expect(telegraph.announcement).toBe(EXPECTED_ANNOUNCEMENT);

    const firstResolution = await stepToFrame(page, FIRST_RESOLUTION_FRAME);
    expect(firstResolution.resolvedCasts).toBe(1);
    expect(firstResolution.cueCount).toBe(0);
    expect(firstResolution.ownedMinions).toBe(3);

    const secondResolution = await stepToFrame(page, SECOND_RESOLUTION_FRAME);
    expect(secondResolution.resolvedCasts).toBe(2);
    expect(secondResolution.ownedMinions).toBeLessThanOrEqual(6);
  }, 120_000);
});
