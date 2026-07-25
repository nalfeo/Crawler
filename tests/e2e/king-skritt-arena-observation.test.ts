import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { colorDist, parsePng, readPixel } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`;
const DELTA_MS = 1000 / 60;
const EXPECTED_ANNOUNCEMENT = 'ROMAN-CANDLE CORONATION — All hail the Unburnt!';
const TELEGRAPH_FRAME = 480;
const FIRST_RESOLUTION_FRAME = 558;
const PROJECTILE_IMPACT_CHECK_FRAME = 900;
const SECOND_RESOLUTION_FRAME = 1116;

interface KingSkrittArenaScene {
  settings: {
    roomPresetId: string;
    floorFilter: string;
    enemyPresetId: string;
    playerMode: string;
    simSpeed: number;
  };
  respawn(): void;
  clearEnemies(): void;
  update(time: number, delta: number): void;
  world: {
    state: string;
    frameCount: number;
    elapsedMs: number;
    announcements: Array<{ kind: string; text?: string }>;
    mobAbilities?: {
      cues?: unknown[];
      pendingBursts?: unknown[];
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

async function configureKingSkrittArena(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: KingSkrittArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing');
    window.__arenaReady = false;
    scene.settings.roomPresetId = 'boss-arena';
    scene.settings.floorFilter = 'floor2';
    scene.settings.enemyPresetId = 'f2-king-skritt';
    scene.settings.playerMode = 'observer';
    scene.settings.simSpeed = 1;
    scene.respawn();
  });
  await page.waitForFunction(
    () => {
      const scene = (window as unknown as { __arenaScene?: KingSkrittArenaScene }).__arenaScene;
      return Boolean(window.__arenaReady) && scene?.settings?.enemyPresetId === 'f2-king-skritt';
    },
    undefined,
    { timeout: 30_000, polling: 200 },
  );
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: KingSkrittArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing after respawn');
    scene.world.state = 'paused';
  });
}

function countChangedPixels(
  beforeBuffer: Buffer,
  afterBuffer: Buffer,
  rect: { x: number; y: number; w: number; h: number },
  threshold = 24,
): number {
  const before = parsePng(beforeBuffer);
  const after = parsePng(afterBuffer);
  let changed = 0;
  let total = 0;
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(before.width - 1, Math.round(rect.x + rect.w));
  const y1 = Math.min(before.height - 1, Math.round(rect.y + rect.h));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += 1;
      if (colorDist(readPixel(before, x, y), readPixel(after, x, y)) > threshold) {
        changed += 1;
      }
    }
  }
  return total === 0 ? 0 : changed / total;
}

async function stepToFrame(page: Page, targetFrame: number) {
  return page.evaluate(
    ({ targetFrame, deltaMs }) => {
      const scene = (window as unknown as { __arenaScene?: KingSkrittArenaScene }).__arenaScene;
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
      const casterEntry = [...(scene.world.mobAbilities?.byEntity?.entries?.() ?? [])][0];
      const casterEid = casterEntry?.[0] ?? null;
      const casterInst = casterEntry?.[1];
      const resolvedCasts = casterInst?.resolvedCasts ?? 0;
      const ownedProjectiles = casterInst?.ownedEntityGenerations?.size ?? 0;
      return {
        frame: scene.world.frameCount,
        elapsedMs: scene.world.elapsedMs,
        cueCount,
        announcement,
        casterEid,
        resolvedCasts,
        ownedProjectiles,
      };
    },
    { targetFrame, deltaMs: DELTA_MS },
  );
}

async function clearEnemiesAndObserveCleanup(page: Page, casterEid: number) {
  return page.evaluate(
    ({ casterEid, deltaMs }) => {
      const scene = (window as unknown as { __arenaScene?: KingSkrittArenaScene }).__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing');
      scene.clearEnemies();
      scene.world.state = 'playing';
      scene.update(0, deltaMs);
      scene.world.state = 'paused';
      const runtime = scene.world.mobAbilities;
      return {
        byEntitySize: runtime?.byEntity?.size ?? 0,
        hasCasterInstance: runtime?.byEntity?.has?.(casterEid) ?? false,
        cueCount: runtime?.cues?.length ?? 0,
        pendingBurstCount: runtime?.pendingBursts?.length ?? 0,
      };
    },
    { casterEid, deltaMs: DELTA_MS },
  );
}

describe('King Skritt arena observation', () => {
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

  it('observes telegraph, projectile launch/impact progression, and cleanup in the live combat arena', async () => {
    await loadArenaLab(page);
    await configureKingSkrittArena(page);

    const before = await stepToFrame(page, TELEGRAPH_FRAME - 1);
    const beforeShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(before.cueCount).toBe(0);
    expect(before.announcement).toBeNull();

    const telegraph = await stepToFrame(page, TELEGRAPH_FRAME);
    const telegraphShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(telegraph.cueCount).toBe(1);
    expect(telegraph.announcement).toBe(EXPECTED_ANNOUNCEMENT);

    const telegraphDiff = countChangedPixels(beforeShot, telegraphShot, {
      x: GAME_W * 0.25,
      y: GAME_H * 0.2,
      w: GAME_W * 0.5,
      h: GAME_H * 0.6,
    });
    const bannerDiff = countChangedPixels(beforeShot, telegraphShot, {
      x: GAME_W * 0.25,
      y: 0,
      w: GAME_W * 0.5,
      h: GAME_H * 0.16,
    });
    expect(telegraphDiff).toBeGreaterThan(0.002);
    expect(bannerDiff).toBeGreaterThan(0.01);

    const firstResolution = await stepToFrame(page, FIRST_RESOLUTION_FRAME);
    expect(firstResolution.resolvedCasts).toBe(1);
    expect(firstResolution.cueCount).toBe(0);
    expect(firstResolution.ownedProjectiles).toBe(12);

    const impactWindow = await stepToFrame(page, PROJECTILE_IMPACT_CHECK_FRAME);
    expect(impactWindow.ownedProjectiles).toBeLessThan(12);

    const secondResolution = await stepToFrame(page, SECOND_RESOLUTION_FRAME);
    expect(secondResolution.resolvedCasts).toBe(2);
    expect(secondResolution.casterEid).not.toBeNull();

    const cleanup = await clearEnemiesAndObserveCleanup(page, secondResolution.casterEid!);
    expect(cleanup.byEntitySize).toBe(0);
    expect(cleanup.hasCasterInstance).toBe(false);
    expect(cleanup.cueCount).toBe(0);
    expect(cleanup.pendingBurstCount).toBe(0);
  }, 120_000);
});
