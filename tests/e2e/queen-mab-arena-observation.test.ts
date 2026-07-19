import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { colorDist, parsePng, readPixel } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`;
const QUEEN_ANNOUNCEMENT = 'VERDIGRIS GLAMOUR — All that glitters will corrode!';
const DELTA_MS = 1000 / 60;
const TELEGRAPH_FRAME = 540;

declare global {
  interface Window {
    __arenaReady?: boolean;
    __arenaScene?: {
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
        mobAbilities?: { cues?: unknown[] };
      };
      children?: {
        list?: Array<{ type?: string; visible?: boolean }>;
      };
    };
  }
}

async function loadArenaLab(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.waitForFunction(() => Boolean(window.__arenaReady), undefined, {
        timeout: 30_000,
        polling: 200,
      });
      await page.waitForTimeout(150);
      return;
    } catch {
      if (attempt < 2) {
        await page.reload({ waitUntil: 'commit', timeout: 45_000 });
        await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
      }
    }
  }
  throw new Error('ArenaScene.create() never set window.__arenaReady');
}

async function configureQueenArena(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scene = window.__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing');
    window.__arenaReady = false;
    scene.settings.roomPresetId = 'boss-arena';
    scene.settings.floorFilter = 'floor2';
    scene.settings.enemyPresetId = 'f2-queen-mab';
    scene.settings.playerMode = 'observer';
    scene.settings.simSpeed = 1;
    scene.respawn();
  });
  await page.waitForFunction(
    () =>
      Boolean(window.__arenaReady) &&
      window.__arenaScene?.settings.enemyPresetId === 'f2-queen-mab',
    undefined,
    { timeout: 30_000, polling: 200 },
  );
  await page.evaluate(() => {
    const scene = window.__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing after respawn');
    scene.world.state = 'paused';
  });
}

interface ArenaProbe {
  readonly frame: number;
  readonly elapsedMs: number;
  readonly graphicsCount: number;
  readonly cueCount: number;
  readonly announcementText: string | null;
}

async function stepToFrame(page: Page, targetFrame: number): Promise<ArenaProbe> {
  return page.evaluate(
    ({ targetFrame, deltaMs, announcement }) => {
      const scene = window.__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing');
      const stepFrames = (count: number) => {
        scene.world.state = 'playing';
        for (let i = 0; i < count; i += 1) {
          scene.update(0, deltaMs);
        }
        scene.world.state = 'paused';
      };
      const currentFrame = scene.world.frameCount;
      if (currentFrame > targetFrame) {
        throw new Error(
          `scene already advanced past target frame ${targetFrame} (at ${currentFrame})`,
        );
      }
      stepFrames(targetFrame - currentFrame);
      const graphicsCount =
        scene.children?.list?.filter((obj) => obj?.type === 'Graphics' && obj.visible !== false)
          .length ?? 0;
      const announcementText =
        scene.world.announcements.find((event) => event.kind === 'bossAbilityCast')?.text ?? null;
      const cueCount = scene.world.mobAbilities?.cues?.length ?? 0;
      const probe = {
        frame: scene.world.frameCount,
        elapsedMs: scene.world.elapsedMs,
        graphicsCount,
        cueCount,
        announcementText,
      } satisfies ArenaProbe;
      if (probe.announcementText !== null && probe.announcementText !== announcement) {
        throw new Error(`unexpected announcement text: ${probe.announcementText}`);
      }
      return probe;
    },
    { targetFrame, deltaMs: DELTA_MS, announcement: QUEEN_ANNOUNCEMENT },
  );
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

describe('Queen Mab arena observation', () => {
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

  it('observes the telegraph/banner transition in the live combat arena before and at frame 540', async () => {
    await loadArenaLab(page);
    await configureQueenArena(page);

    const before = await stepToFrame(page, TELEGRAPH_FRAME - 1);
    const beforeShot = await page.locator('#lab-canvas canvas').screenshot();

    const after = await stepToFrame(page, TELEGRAPH_FRAME);
    const afterShot = await page.locator('#lab-canvas canvas').screenshot();

    expect(before.frame).toBe(TELEGRAPH_FRAME - 1);
    expect(before.elapsedMs).toBeCloseTo(9000 - DELTA_MS, 6);
    expect(before.cueCount).toBe(0);
    expect(before.announcementText).toBeNull();

    expect(after.frame).toBe(TELEGRAPH_FRAME);
    expect(after.elapsedMs).toBeCloseTo(9000, 6);
    expect(after.cueCount).toBe(1);
    expect(after.announcementText).toBe(QUEEN_ANNOUNCEMENT);
    expect(after.graphicsCount).toBeGreaterThan(before.graphicsCount);

    const telegraphDiff = countChangedPixels(beforeShot, afterShot, {
      x: GAME_W * 0.3,
      y: GAME_H * 0.3,
      w: GAME_W * 0.4,
      h: GAME_H * 0.4,
    });
    const bannerDiff = countChangedPixels(beforeShot, afterShot, {
      x: GAME_W * 0.25,
      y: 0,
      w: GAME_W * 0.5,
      h: GAME_H * 0.16,
    });

    expect(telegraphDiff).toBeGreaterThan(0.002);
    expect(bannerDiff).toBeGreaterThan(0.01);
  });
});
