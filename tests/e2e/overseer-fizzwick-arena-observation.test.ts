import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { colorDist, parsePng, readPixel } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`;
const FIZZWICK_ANNOUNCEMENT = 'CLOCKWORK KILL-SAW — Mandatory overtime starts now!';
const DELTA_MS = 1000 / 60;
const TELEGRAPH_FRAME = 540;
const OUTBOUND_FRAME = 619;
const HOLD_FRAME = 650;
const RETURN_FRAME = 680;
const RECATCH_FRAME = 700;
const SECOND_TELEGRAPH_FRAME = 1240;
const SECOND_RECATCH_FRAME = 1400;

interface FizzwickArenaScene {
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
      cues?: Array<{
        phase?: string;
        projectileX?: number;
        projectileY?: number;
      }>;
    };
  };
  children?: {
    list?: Array<{ type?: string; visible?: boolean }>;
  };
}

interface ArenaProbe {
  readonly frame: number;
  readonly elapsedMs: number;
  readonly graphicsCount: number;
  readonly cueCount: number;
  readonly phase: string | null;
  readonly projectileY: number | null;
  readonly announcementText: string | null;
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

async function configureFizzwickArena(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: FizzwickArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing');
    window.__arenaReady = false;
    scene.settings.roomPresetId = 'boss-arena';
    scene.settings.floorFilter = 'floor2';
    scene.settings.enemyPresetId = 'f2-overseer-fizzwick';
    scene.settings.playerMode = 'observer';
    scene.settings.simSpeed = 1;
    scene.respawn();
  });
  await page.waitForFunction(
    () => {
      const scene = (window as unknown as { __arenaScene?: FizzwickArenaScene }).__arenaScene;
      return (
        Boolean(window.__arenaReady) && scene?.settings?.enemyPresetId === 'f2-overseer-fizzwick'
      );
    },
    undefined,
    { timeout: 30_000, polling: 200 },
  );
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: FizzwickArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing after respawn');
    scene.world.state = 'paused';
  });
}

async function stepToFrame(page: Page, targetFrame: number): Promise<ArenaProbe> {
  return page.evaluate(
    ({ targetFrame, deltaMs, announcement }) => {
      const scene = (window as unknown as { __arenaScene?: FizzwickArenaScene }).__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing');
      const stepFrames = (count: number) => {
        scene.world.state = 'playing';
        for (let i = 0; i < count; i += 1) scene.update(0, deltaMs);
        scene.world.state = 'paused';
      };
      const currentFrame = scene.world.frameCount;
      if (currentFrame > targetFrame) {
        throw new Error(
          `scene already advanced past target frame ${targetFrame} (at ${currentFrame})`,
        );
      }
      stepFrames(targetFrame - currentFrame);
      const cue = scene.world.mobAbilities?.cues?.[0];
      const probe = {
        frame: scene.world.frameCount,
        elapsedMs: scene.world.elapsedMs,
        graphicsCount:
          scene.children?.list?.filter((obj) => obj?.type === 'Graphics' && obj.visible !== false)
            .length ?? 0,
        cueCount: scene.world.mobAbilities?.cues?.length ?? 0,
        phase: cue?.phase ?? null,
        projectileY: cue?.projectileY ?? null,
        announcementText:
          scene.world.announcements.find((event) => event.kind === 'bossAbilityCast')?.text ?? null,
      } satisfies ArenaProbe;
      if (probe.announcementText !== null && probe.announcementText !== announcement) {
        throw new Error(`unexpected announcement text: ${probe.announcementText}`);
      }
      return probe;
    },
    { targetFrame, deltaMs: DELTA_MS, announcement: FIZZWICK_ANNOUNCEMENT },
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
      if (colorDist(readPixel(before, x, y), readPixel(after, x, y)) > threshold) changed += 1;
    }
  }
  return total === 0 ? 0 : changed / total;
}

describe('Overseer Fizzwick arena observation', () => {
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

  it('observes telegraph, outbound, hold, return, re-catch cleanup, and second cast in the live combat arena', async () => {
    await loadArenaLab(page);
    await configureFizzwickArena(page);

    const before = await stepToFrame(page, TELEGRAPH_FRAME - 1);
    const beforeShot = await page.locator('#lab-canvas canvas').screenshot();

    const telegraph = await stepToFrame(page, TELEGRAPH_FRAME);
    const telegraphShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(before.cueCount).toBe(0);
    expect(telegraph.cueCount).toBe(1);
    expect(telegraph.phase).toBe('telegraph');
    expect(telegraph.announcementText).toBe(FIZZWICK_ANNOUNCEMENT);
    expect(telegraph.graphicsCount).toBeGreaterThan(before.graphicsCount);
    expect(
      countChangedPixels(beforeShot, telegraphShot, {
        x: GAME_W * 0.2,
        y: GAME_H * 0.2,
        w: GAME_W * 0.6,
        h: GAME_H * 0.45,
      }),
    ).toBeGreaterThan(0.003);

    const outbound = await stepToFrame(page, OUTBOUND_FRAME);
    const outboundShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(outbound.phase).toBe('outbound');
    expect(outbound.projectileY).not.toBeNull();
    expect(outbound.projectileY!).toBeGreaterThan(telegraph.projectileY ?? 10);
    expect(
      countChangedPixels(telegraphShot, outboundShot, {
        x: GAME_W * 0.25,
        y: GAME_H * 0.2,
        w: GAME_W * 0.5,
        h: GAME_H * 0.45,
      }),
    ).toBeGreaterThan(0.002);

    const hold = await stepToFrame(page, HOLD_FRAME);
    const holdShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(hold.phase).toBe('hold');
    expect(hold.projectileY).not.toBeNull();
    expect(hold.projectileY!).toBeGreaterThan(outbound.projectileY!);
    expect(
      countChangedPixels(outboundShot, holdShot, {
        x: GAME_W * 0.25,
        y: GAME_H * 0.2,
        w: GAME_W * 0.5,
        h: GAME_H * 0.45,
      }),
    ).toBeGreaterThan(0.001);

    const returning = await stepToFrame(page, RETURN_FRAME);
    const returnShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(returning.phase).toBe('return');
    expect(returning.projectileY).not.toBeNull();
    expect(returning.projectileY!).toBeLessThan(hold.projectileY!);
    expect(
      countChangedPixels(holdShot, returnShot, {
        x: GAME_W * 0.25,
        y: GAME_H * 0.2,
        w: GAME_W * 0.5,
        h: GAME_H * 0.45,
      }),
    ).toBeGreaterThan(0.001);

    const recatch = await stepToFrame(page, RECATCH_FRAME);
    const recatchShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(recatch.cueCount).toBe(0);
    expect(recatch.phase).toBeNull();
    expect(
      countChangedPixels(returnShot, recatchShot, {
        x: GAME_W * 0.25,
        y: GAME_H * 0.15,
        w: GAME_W * 0.5,
        h: GAME_H * 0.45,
      }),
    ).toBeGreaterThan(0.001);

    const secondTelegraph = await stepToFrame(page, SECOND_TELEGRAPH_FRAME);
    expect(secondTelegraph.cueCount).toBe(1);
    expect(secondTelegraph.phase).toBe('telegraph');

    const secondRecatch = await stepToFrame(page, SECOND_RECATCH_FRAME);
    expect(secondRecatch.cueCount).toBe(0);
    expect(secondRecatch.phase).toBeNull();
  });
});
