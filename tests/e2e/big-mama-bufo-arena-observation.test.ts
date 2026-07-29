import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { colorDist, parsePng, readPixel } from './helpers/pixels.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`;
const ANNOUNCEMENT = "TONGUE REPOSSESSION — Big Mama wants what's hers!";
const DELTA_MS = 1000 / 60;
const TELEGRAPH_1 = 480;
const RESOLUTION_1 = 555;
const TELEGRAPH_2 = 1035;
const RESOLUTION_2 = 1110;

interface BufoArenaScene {
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
    stores: {
      position: {
        x: Float32Array;
        y: Float32Array;
      };
    };
    mobAbilities?: {
      cues?: Array<{
        geometry?:
          | LaneCueGeometry
          | { kind: 'circle'; x: number; y: number; radiusFt: number }
          | { kind: 'spawn-circles' };
      }>;
      byEntity?: Map<number, unknown>;
    };
  };
  children?: {
    list?: Array<{ type?: string; visible?: boolean }>;
  };
}

interface ArenaProbe {
  readonly frame: number;
  readonly cueCount: number;
  readonly graphicsCount: number;
  readonly announcementText: string | null;
  readonly playerX: number;
  readonly playerY: number;
  readonly lane: {
    originX: number;
    originY: number;
    endX: number;
    endY: number;
    dirX: number;
    dirY: number;
    widthFt: number;
    lengthFt: number;
  } | null;
}

type LaneProbe = NonNullable<ArenaProbe['lane']>;
interface LaneCueGeometry extends LaneProbe {
  readonly kind: 'lane';
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

async function loadArenaLab(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__arenaReady), undefined, {
    timeout: 30_000,
    polling: 200,
  });
}

async function configureArena(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: BufoArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing');
    window.__arenaReady = false;
    scene.settings.roomPresetId = 'boss-arena';
    scene.settings.floorFilter = 'floor2';
    scene.settings.enemyPresetId = 'f2-big-mama-bufo';
    scene.settings.playerMode = 'observer';
    scene.settings.simSpeed = 1;
    scene.respawn();
  });
  await page.waitForFunction(
    () => {
      const scene = (window as unknown as { __arenaScene?: BufoArenaScene }).__arenaScene;
      return Boolean(window.__arenaReady) && scene?.settings?.enemyPresetId === 'f2-big-mama-bufo';
    },
    undefined,
    { timeout: 30_000, polling: 200 },
  );
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: BufoArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing after respawn');
    scene.world.state = 'paused';
  });
}

async function stepToFrame(page: Page, targetFrame: number): Promise<ArenaProbe> {
  return page.evaluate(
    ({ targetFrame, deltaMs, announcement }) => {
      const scene = (window as unknown as { __arenaScene?: BufoArenaScene }).__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing');
      if (scene.world.frameCount > targetFrame) {
        throw new Error(`already past frame ${targetFrame}`);
      }
      scene.world.state = 'playing';
      for (let i = scene.world.frameCount; i < targetFrame; i += 1) {
        scene.update(0, deltaMs);
      }
      scene.world.state = 'paused';
      const graphicsCount =
        scene.children?.list?.filter((obj) => obj?.type === 'Graphics' && obj.visible !== false)
          .length ?? 0;
      const announcementText =
        scene.world.announcements.find((event) => event.kind === 'bossAbilityCast')?.text ?? null;
      if (announcementText !== null && announcementText !== announcement) {
        throw new Error(`unexpected announcement text: ${announcementText}`);
      }
      const playerEid = scene.playerEid;
      const laneCue = scene.world.mobAbilities?.cues?.find(
        (cue) => cue?.geometry?.kind === 'lane',
      )?.geometry;
      let lane: LaneProbe | null = null;
      if (
        laneCue !== null &&
        laneCue !== undefined &&
        laneCue.kind === 'lane' &&
        'originX' in laneCue &&
        'originY' in laneCue &&
        'endX' in laneCue &&
        'endY' in laneCue &&
        'dirX' in laneCue &&
        'dirY' in laneCue &&
        'widthFt' in laneCue &&
        'lengthFt' in laneCue
      ) {
        const committedLane = laneCue;
        lane = {
          originX: committedLane.originX,
          originY: committedLane.originY,
          endX: committedLane.endX,
          endY: committedLane.endY,
          dirX: committedLane.dirX,
          dirY: committedLane.dirY,
          widthFt: committedLane.widthFt,
          lengthFt: committedLane.lengthFt,
        };
      }
      return {
        frame: scene.world.frameCount,
        cueCount: scene.world.mobAbilities?.cues?.length ?? 0,
        graphicsCount,
        announcementText,
        playerX: scene.world.stores.position.x[playerEid] ?? 0,
        playerY: scene.world.stores.position.y[playerEid] ?? 0,
        lane,
      } satisfies ArenaProbe;
    },
    { targetFrame, deltaMs: DELTA_MS, announcement: ANNOUNCEMENT },
  );
}

describe('Big Mama Bufo arena observation', () => {
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

  it('observes telegraph lock, miss sidestep, and second-cast pull in the live arena', async () => {
    await loadArenaLab(page);
    await configureArena(page);

    const before = await stepToFrame(page, TELEGRAPH_1 - 1);
    const beforeShot = await page.locator('#lab-canvas canvas').screenshot();
    const telegraph1 = await stepToFrame(page, TELEGRAPH_1);
    const telegraphShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(before.cueCount).toBe(0);
    expect(before.announcementText).toBeNull();
    expect(telegraph1.cueCount).toBe(1);
    expect(telegraph1.announcementText).toBe(ANNOUNCEMENT);
    expect(telegraph1.graphicsCount).toBeGreaterThan(before.graphicsCount);

    const laneDiff = countChangedPixels(beforeShot, telegraphShot, {
      x: GAME_W * 0.2,
      y: GAME_H * 0.25,
      w: GAME_W * 0.6,
      h: GAME_H * 0.45,
    });
    expect(laneDiff).toBeGreaterThan(0.001);

    await page.evaluate(() => {
      const scene = (window as unknown as { __arenaScene?: BufoArenaScene }).__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing for sidestep');
      const playerEid = scene.playerEid;
      scene.world.stores.position.x[playerEid] = 55;
      scene.world.stores.position.y[playerEid] = 40;
    });

    const missResolution = await stepToFrame(page, RESOLUTION_1);
    expect(missResolution.cueCount).toBe(0);
    expect(missResolution.playerX).toBeCloseTo(55, 3);
    expect(missResolution.playerY).toBeCloseTo(40, 3);

    await stepToFrame(page, TELEGRAPH_2 - 1);

    await page.evaluate(() => {
      const scene = (window as unknown as { __arenaScene?: BufoArenaScene }).__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing for second telegraph setup');
      const [casterEid] = scene.world.mobAbilities?.byEntity?.keys?.() ?? [];
      if (casterEid === undefined) throw new Error('Bufo caster missing before second telegraph');
      const playerEid = scene.playerEid;
      const casterX = scene.world.stores.position.x[casterEid] ?? 0;
      const casterY = scene.world.stores.position.y[casterEid] ?? 0;
      scene.world.stores.position.x[playerEid] = casterX;
      scene.world.stores.position.y[playerEid] = casterY + 20;
    });

    const telegraph2 = await stepToFrame(page, TELEGRAPH_2);
    expect(telegraph2.cueCount).toBe(1);
    expect(telegraph2.announcementText).toBe(ANNOUNCEMENT);
    expect(telegraph2.lane).not.toBeNull();

    const hitResolution = await stepToFrame(page, RESOLUTION_2);
    expect(hitResolution.cueCount).toBe(0);
    expect(hitResolution.playerX).toBeCloseTo(
      telegraph2.lane!.originX + telegraph2.lane!.dirX * 5,
      3,
    );
    expect(hitResolution.playerY).toBeCloseTo(
      telegraph2.lane!.originY + telegraph2.lane!.dirY * 5,
      3,
    );
  }, 120_000);
});
