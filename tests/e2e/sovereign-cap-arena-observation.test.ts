import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { colorDist, parsePng, readPixel } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`;
const ANNOUNCEMENT = 'SOVEREIGN SPORE BLOOM — The colony claims this ground!';
const DELTA_MS = 1000 / 60;
const TELEGRAPH_FRAME = 540;
const RESOLUTION_FRAME = 636;
const CLOUD_TICK_FRAME = 666;
const CLOUD_EXPIRE_FRAME = 876;
const SECOND_TELEGRAPH_FRAME = 1176;
const SECOND_RESOLUTION_FRAME = 1272;

interface CircleScreenPos {
  screenX: number;
  screenY: number;
  radiusPx: number;
}

interface SovereignArenaScene {
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
    stores: { health: { current: ArrayLike<number> } };
    mobAbilities: {
      cues?: unknown[];
      ownedZones: Array<{
        id: number;
        geometry?: { kind: string; circles?: Array<{ x: number; y: number; radiusFt: number }> };
      }>;
    };
  };
  playerEid?: number;
  children?: { list?: Array<{ type?: string; visible?: boolean }> };
  cameras: { main: { scrollX: number; scrollY: number } };
}

/** Read the screen positions of the three committed cloud circles from the live scene.
 *
 * Phaser's Scale.FIT mode scales the canvas CSS display size to fit the parent container
 * (which is narrower than the 1280×720 logical game resolution due to the 300px controls
 * panel). `page.locator('canvas').screenshot()` returns CSS-sized pixels, so we must
 * apply the CSS display scale factor so the returned positions index correctly into the
 * screenshot buffer.
 */
async function getCloudCircleScreenPositions(page: Page): Promise<CircleScreenPos[] | null> {
  return page.evaluate(() => {
    const GAME_LOGICAL_W = 1280;
    const PIXELS_PER_FOOT = 8;
    const scene = (window as unknown as { __arenaScene?: SovereignArenaScene }).__arenaScene;
    if (!scene) return null;
    const cam = scene.cameras.main;
    const zones = scene.world.mobAbilities.ownedZones;
    const geom = zones[0]?.geometry;
    if (!geom || geom.kind !== 'multi-circle' || !geom.circles) return null;
    // Compute the CSS display scale factor. Phaser.Scale.FIT sets the canvas CSS width to
    // the actual rendered display width, which may be less than GAME_LOGICAL_W when the
    // container is smaller. Screenshot pixels are in CSS space, so all positions must be
    // multiplied by this factor.
    const canvas = document.querySelector('#lab-canvas canvas') as HTMLCanvasElement | null;
    const cssW = canvas ? canvas.getBoundingClientRect().width : GAME_LOGICAL_W;
    const displayScale = cssW > 0 ? cssW / GAME_LOGICAL_W : 1;
    return geom.circles.map((c) => ({
      screenX: (c.x * PIXELS_PER_FOOT - cam.scrollX) * displayScale,
      screenY: (c.y * PIXELS_PER_FOOT - cam.scrollY) * displayScale,
      radiusPx: c.radiusFt * PIXELS_PER_FOOT * displayScale,
    }));
  });
}

/**
 * Assert that each cloud circle shows changed pixels near its rim in `afterShot` vs `beforeShot`.
 * For each circle we check a bounding box around the entire circle; the box must
 * contain at least `minFraction` changed pixels (default 0.5 %).
 */
function assertCloudRimsVisible(
  beforeShot: Buffer,
  afterShot: Buffer,
  circles: CircleScreenPos[],
  minFraction = 0.005,
): void {
  for (let i = 0; i < circles.length; i += 1) {
    const { screenX, screenY, radiusPx } = circles[i]!;
    // Sample a generous bounding box around the entire circle.
    const margin = Math.ceil(radiusPx * 0.25);
    const rect = {
      x: Math.round(screenX - radiusPx - margin),
      y: Math.round(screenY - radiusPx - margin),
      w: Math.round((radiusPx + margin) * 2),
      h: Math.round((radiusPx + margin) * 2),
    };
    const diff = countChangedPixels(beforeShot, afterShot, rect);
    expect(diff, `circle ${i} rim should show changed pixels vs baseline`).toBeGreaterThan(
      minFraction,
    );
  }
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
    const scene = (window as unknown as { __arenaScene?: SovereignArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing');
    window.__arenaReady = false;
    scene.settings.roomPresetId = 'boss-arena';
    scene.settings.floorFilter = 'floor2';
    scene.settings.enemyPresetId = 'f2-sovereign-cap';
    scene.settings.playerMode = 'observer';
    scene.settings.simSpeed = 1;
    scene.respawn();
  });
  await page.waitForFunction(
    () => {
      const scene = (window as unknown as { __arenaScene?: SovereignArenaScene }).__arenaScene;
      return Boolean(window.__arenaReady) && scene?.settings?.enemyPresetId === 'f2-sovereign-cap';
    },
    undefined,
    { timeout: 30_000, polling: 200 },
  );
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: SovereignArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing after respawn');
    scene.world.state = 'paused';
  });
}

interface ArenaProbe {
  readonly frame: number;
  readonly elapsedMs: number;
  readonly graphicsCount: number;
  readonly cueCount: number;
  readonly zoneCount: number;
  readonly announcementText: string | null;
  readonly playerHp: number;
}

async function stepToFrame(page: Page, targetFrame: number): Promise<ArenaProbe> {
  return page.evaluate(
    ({ targetFrame, deltaMs, announcement }) => {
      const scene = (window as unknown as { __arenaScene?: SovereignArenaScene }).__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing');
      const stepFrames = (count: number) => {
        scene.world.state = 'playing';
        for (let i = 0; i < count; i += 1) {
          scene.update(0, deltaMs);
        }
        scene.world.state = 'paused';
      };
      if (scene.world.frameCount > targetFrame) {
        throw new Error(`already past target frame ${targetFrame}`);
      }
      stepFrames(targetFrame - scene.world.frameCount);
      const graphicsCount =
        scene.children?.list?.filter((obj) => obj?.type === 'Graphics' && obj.visible !== false)
          .length ?? 0;
      const announcementText =
        scene.world.announcements.find((event) => event.kind === 'bossAbilityCast')?.text ?? null;
      const cueCount = scene.world.mobAbilities?.cues?.length ?? 0;
      const zoneCount = scene.world.mobAbilities?.ownedZones?.length ?? 0;
      const playerEid = scene.playerEid ?? 0;
      const playerHp = scene.world.stores.health.current[playerEid] ?? 0;
      const probe = {
        frame: scene.world.frameCount,
        elapsedMs: scene.world.elapsedMs,
        graphicsCount,
        cueCount,
        zoneCount,
        announcementText,
        playerHp,
      } satisfies ArenaProbe;
      if (probe.announcementText !== null && probe.announcementText !== announcement) {
        throw new Error(`unexpected announcement text: ${probe.announcementText}`);
      }
      return probe;
    },
    { targetFrame, deltaMs: DELTA_MS, announcement: ANNOUNCEMENT },
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

describe('Sovereign Cap arena observation', () => {
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

  it('observes telegraph, impact, persistent clouds, cleanup, and second cast in the live arena', async () => {
    await loadArenaLab(page);
    await configureArena(page);

    const before = await stepToFrame(page, TELEGRAPH_FRAME - 1);
    const beforeShot = await page.locator('#lab-canvas canvas').screenshot();

    const telegraph = await stepToFrame(page, TELEGRAPH_FRAME);
    const telegraphShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(before.cueCount).toBe(0);
    expect(before.zoneCount).toBe(0);
    expect(before.announcementText).toBeNull();
    expect(telegraph.cueCount).toBe(1);
    expect(telegraph.announcementText).toBe(ANNOUNCEMENT);

    const telegraphDiff = countChangedPixels(beforeShot, telegraphShot, {
      x: GAME_W * 0.2,
      y: GAME_H * 0.2,
      w: GAME_W * 0.6,
      h: GAME_H * 0.55,
    });
    expect(telegraphDiff).toBeGreaterThan(0.002);

    const resolved = await stepToFrame(page, RESOLUTION_FRAME);
    expect(resolved.cueCount).toBe(0);
    expect(resolved.zoneCount).toBe(1);
    expect(resolved.playerHp).toBeLessThan(before.playerHp);

    // Capture committed circle screen positions right after resolution (zones live).
    const cloudCircles = await getCloudCircleScreenPositions(page);
    expect(cloudCircles).not.toBeNull();
    expect(cloudCircles?.length).toBe(3);

    // Advance to the first cloud tick before checking visuals. The extra page.evaluate
    // round-trip between stepToFrame calls gives Phaser's requestAnimationFrame render
    // loop a chance to paint the newly-created cloud zone Graphics onto the WebGL canvas
    // before the screenshot is taken.
    const cloudTick = await stepToFrame(page, CLOUD_TICK_FRAME);
    const cloudTickShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(cloudTick.zoneCount).toBe(1);
    expect(cloudTick.playerHp).toBeLessThan(resolved.playerHp);

    // Verify all three cloud circle rims are visible at the first tick (near creation).
    if (cloudCircles) {
      assertCloudRimsVisible(beforeShot, cloudTickShot, cloudCircles);
    }

    // Verify all three rims are still visible near expiry (just before cleanup).
    const preExpireFrame = CLOUD_EXPIRE_FRAME - 1;
    await stepToFrame(page, preExpireFrame);
    const preExpireShot = await page.locator('#lab-canvas canvas').screenshot();
    if (cloudCircles) {
      assertCloudRimsVisible(beforeShot, preExpireShot, cloudCircles);
    }

    const cloudExpire = await stepToFrame(page, CLOUD_EXPIRE_FRAME);
    expect(cloudExpire.zoneCount).toBe(0);

    const telegraph2 = await stepToFrame(page, SECOND_TELEGRAPH_FRAME);
    expect(telegraph2.cueCount).toBe(1);
    expect(telegraph2.zoneCount).toBe(0);

    const resolved2 = await stepToFrame(page, SECOND_RESOLUTION_FRAME);
    expect(resolved2.cueCount).toBe(0);
    expect(resolved2.zoneCount).toBe(1);
    expect(resolved2.playerHp).toBeLessThan(cloudExpire.playerHp);
  }, 120_000);
});
