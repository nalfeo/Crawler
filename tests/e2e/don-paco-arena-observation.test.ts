import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { colorDist, parsePng, readPixel } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`;
const ANNOUNCEMENT = "THE BIG GOB — Don Paco's painting the whole block!";
const DELTA_MS = 1000 / 60;
const TELEGRAPH_FRAME = 540;
const RESOLUTION_FRAME = 624;
const IMPACT_FRAME = 654;
const SLOW_FRAME = 655;
const CLEANUP_FRAME = 894;
const SECOND_IMPACT_FRAME = 1278;

interface DonPacoArenaScene {
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
    player: number;
    announcements: Array<{ kind: string; text?: string }>;
    statusEffectsByEntity?: Map<number, Array<{ sourceId: string }>>;
    mobAbilities: {
      cues: unknown[];
      activeProjectiles: unknown[];
      activeZones: Array<{ circle: { x: number; y: number; radiusFt: number } }>;
    };
  };
}

interface ArenaProbe {
  readonly frame: number;
  readonly cueCount: number;
  readonly projectileCount: number;
  readonly zoneCount: number;
  readonly announcementText: string | null;
  readonly slickActive: boolean;
}

type PngBuffer = Parameters<typeof parsePng>[0];

async function loadArenaLab(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
  await page.waitForFunction(
    () => Boolean((window as typeof window & { __arenaReady?: boolean }).__arenaReady),
    undefined,
    {
      timeout: 30_000,
      polling: 200,
    },
  );
}

async function configureArena(page: Page): Promise<void> {
  await page.evaluate(() => {
    const arenaWindow = window as typeof window & {
      __arenaReady?: boolean;
      __arenaScene?: DonPacoArenaScene;
    };
    const scene = arenaWindow.__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing');
    arenaWindow.__arenaReady = false;
    scene.settings.roomPresetId = 'boss-arena';
    scene.settings.floorFilter = 'floor2';
    scene.settings.enemyPresetId = 'f2-don-paco';
    scene.settings.playerMode = 'observer';
    scene.settings.simSpeed = 1;
    scene.respawn();
  });
  await page.waitForFunction(
    () => {
      const arenaWindow = window as typeof window & {
        __arenaReady?: boolean;
        __arenaScene?: DonPacoArenaScene;
      };
      const scene = arenaWindow.__arenaScene;
      return Boolean(arenaWindow.__arenaReady) && scene?.settings?.enemyPresetId === 'f2-don-paco';
    },
    undefined,
    { timeout: 30_000, polling: 200 },
  );
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: DonPacoArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing after respawn');
    scene.world.state = 'paused';
  });
}

async function stepToFrame(page: Page, targetFrame: number): Promise<ArenaProbe> {
  return page.evaluate(
    ({
      targetFrame,
      deltaMs,
      announcement,
    }: {
      targetFrame: number;
      deltaMs: number;
      announcement: string;
    }) => {
      const scene = (window as unknown as { __arenaScene?: DonPacoArenaScene }).__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing');
      if (scene.world.frameCount > targetFrame) {
        throw new Error(`already past target frame ${targetFrame}`);
      }
      scene.world.state = 'playing';
      for (let i = scene.world.frameCount; i < targetFrame; i += 1) {
        scene.update(0, deltaMs);
      }
      scene.world.state = 'paused';
      const announcementText =
        scene.world.announcements.find((event) => event.kind === 'bossAbilityCast')?.text ?? null;
      if (announcementText !== null && announcementText !== announcement) {
        throw new Error(`unexpected announcement text: ${announcementText}`);
      }
      const slickEffects =
        scene.world.statusEffectsByEntity
          ?.get(scene.world.player)
          ?.filter((effect) => effect.sourceId.endsWith(':slick')) ?? [];
      return {
        frame: scene.world.frameCount,
        cueCount: scene.world.mobAbilities.cues.length,
        projectileCount: scene.world.mobAbilities.activeProjectiles.length,
        zoneCount: scene.world.mobAbilities.activeZones.length,
        announcementText,
        slickActive: slickEffects.length > 0,
      } satisfies ArenaProbe;
    },
    { targetFrame, deltaMs: DELTA_MS, announcement: ANNOUNCEMENT },
  );
}

function countChangedPixels(
  beforeBuffer: PngBuffer,
  afterBuffer: PngBuffer,
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
      if (colorDist(readPixel(before, x, y), readPixel(after, x, y)) > threshold) changed += 1;
    }
  }
  return total === 0 ? 0 : changed / total;
}

async function clearEnemiesAndObserveCleanup(page: Page) {
  return page.evaluate(
    ({ deltaMs }: { deltaMs: number }) => {
      const scene = (window as unknown as { __arenaScene?: DonPacoArenaScene }).__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing');
      scene.clearEnemies();
      scene.world.state = 'playing';
      scene.update(0, deltaMs);
      scene.world.state = 'paused';
      return {
        cueCount: scene.world.mobAbilities.cues.length,
        projectileCount: scene.world.mobAbilities.activeProjectiles.length,
        zoneCount: scene.world.mobAbilities.activeZones.length,
      };
    },
    { deltaMs: DELTA_MS },
  );
}

describe('Don Paco arena observation', () => {
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

  it('observes telegraph, launch, impacts, slicks, cleanup, and second cast in the live arena', async () => {
    await loadArenaLab(page);
    await configureArena(page);

    const before = await stepToFrame(page, TELEGRAPH_FRAME - 1);
    const beforeShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(before.cueCount).toBe(0);
    expect(before.projectileCount).toBe(0);
    expect(before.zoneCount).toBe(0);
    expect(before.announcementText).toBeNull();

    const telegraph = await stepToFrame(page, TELEGRAPH_FRAME);
    const telegraphShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(telegraph.cueCount).toBe(1);
    expect(telegraph.announcementText).toBe(ANNOUNCEMENT);
    const telegraphDiff = countChangedPixels(beforeShot, telegraphShot, {
      x: GAME_W * 0.2,
      y: GAME_H * 0.15,
      w: GAME_W * 0.6,
      h: GAME_H * 0.55,
    });
    expect(telegraphDiff).toBeGreaterThan(0.002);

    const launch = await stepToFrame(page, RESOLUTION_FRAME);
    expect(launch.cueCount).toBe(0);
    expect(launch.projectileCount).toBe(5);
    expect(launch.zoneCount).toBe(0);

    const impactBeforeShot = await page.locator('#lab-canvas canvas').screenshot();
    const impact = await stepToFrame(page, IMPACT_FRAME);
    const impactShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(impact.projectileCount).toBe(0);
    expect(impact.zoneCount).toBe(5);
    const impactDiff = countChangedPixels(impactBeforeShot, impactShot, {
      x: GAME_W * 0.2,
      y: GAME_H * 0.15,
      w: GAME_W * 0.6,
      h: GAME_H * 0.55,
    });
    expect(impactDiff).toBeGreaterThan(0.002);
    const slow = await stepToFrame(page, SLOW_FRAME);
    expect(slow.zoneCount).toBe(5);

    const cleanup = await stepToFrame(page, CLEANUP_FRAME);
    expect(cleanup.projectileCount).toBe(0);
    expect(cleanup.zoneCount).toBe(0);

    const secondImpact = await stepToFrame(page, SECOND_IMPACT_FRAME);
    expect(secondImpact.zoneCount).toBe(5);

    const finalCleanup = await clearEnemiesAndObserveCleanup(page);
    expect(finalCleanup.cueCount).toBe(0);
    expect(finalCleanup.projectileCount).toBe(0);
    expect(finalCleanup.zoneCount).toBe(0);
  }, 120_000);
});
