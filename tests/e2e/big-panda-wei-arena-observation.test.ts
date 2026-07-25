import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { colorDist, parsePng, readPixel } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`;
const ANNOUNCEMENT = 'BAMBOO-FED BERSERK — Big Wei is collecting personally!';
const DELTA_MS = 1000 / 60;
const TELEGRAPH_FRAME = 600;
const RESOLUTION_FRAME = 690;
const EXPIRY_FRAME = 930;
const SECOND_TELEGRAPH_FRAME = 1290;
const SECOND_RESOLUTION_FRAME = 1380;

interface WeiArenaScene {
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
    mobAbilities: {
      cues?: unknown[];
      activeBuffsByEntity: Map<
        number,
        {
          abilityId: string;
          remainingMs: number;
          movementSpeedMultiplier: number;
          meleeDamageMultiplier: number;
          knockbackResistanceMultiplier: number;
        }
      >;
    };
  };
  children?: {
    list?: Array<{ type?: string; visible?: boolean; name?: string }>;
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

async function configureArena(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: WeiArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing');
    window.__arenaReady = false;
    scene.settings.roomPresetId = 'boss-arena';
    scene.settings.floorFilter = 'floor2';
    scene.settings.enemyPresetId = 'f2-big-panda-wei';
    scene.settings.playerMode = 'observer';
    scene.settings.simSpeed = 1;
    scene.respawn();
  });
  await page.waitForFunction(
    () => {
      const scene = (window as unknown as { __arenaScene?: WeiArenaScene }).__arenaScene;
      return Boolean(window.__arenaReady) && scene?.settings?.enemyPresetId === 'f2-big-panda-wei';
    },
    undefined,
    { timeout: 30_000, polling: 200 },
  );
  await page.evaluate(() => {
    const scene = (window as unknown as { __arenaScene?: WeiArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing after respawn');
    scene.world.state = 'paused';
  });
}

interface ArenaProbe {
  readonly frame: number;
  readonly elapsedMs: number;
  readonly graphicsCount: number;
  readonly auraGraphicsCount: number;
  readonly cueCount: number;
  readonly announcementText: string | null;
  readonly berserkActive: boolean;
  readonly movementMultiplier: number;
  readonly meleeMultiplier: number;
  readonly knockbackMultiplier: number;
}

async function stepToFrame(page: Page, targetFrame: number): Promise<ArenaProbe> {
  return page.evaluate(
    ({ targetFrame, deltaMs, announcement }) => {
      const scene = (window as unknown as { __arenaScene?: WeiArenaScene }).__arenaScene;
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
      const auraGraphicsCount =
        scene.children?.list?.filter(
          (obj) => obj?.type === 'Graphics' && obj.visible !== false && obj.name === 'berserkAura',
        ).length ?? 0;
      const announcementText =
        scene.world.announcements.find((event) => event.kind === 'bossAbilityCast')?.text ?? null;
      const cueCount = scene.world.mobAbilities?.cues?.length ?? 0;
      const activeBuff = [...scene.world.mobAbilities.activeBuffsByEntity.values()].find(
        (buff) => buff.abilityId === 'big-panda-wei-bamboo-fed-berserk',
      );
      const berserkActive = activeBuff !== undefined;
      const probe = {
        frame: scene.world.frameCount,
        elapsedMs: scene.world.elapsedMs,
        graphicsCount,
        auraGraphicsCount,
        cueCount,
        announcementText,
        berserkActive,
        movementMultiplier: activeBuff?.movementSpeedMultiplier ?? 1,
        meleeMultiplier: activeBuff?.meleeDamageMultiplier ?? 1,
        knockbackMultiplier: activeBuff?.knockbackResistanceMultiplier ?? 1,
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

describe('Big Panda Wei arena observation', () => {
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

  it('observes wind-up, active aura/modifiers, expiry/cleanup, and second cast in the live arena', async () => {
    await loadArenaLab(page);
    await configureArena(page);

    const before = await stepToFrame(page, TELEGRAPH_FRAME - 1);
    const beforeShot = await page.locator('#lab-canvas canvas').screenshot();

    const telegraph = await stepToFrame(page, TELEGRAPH_FRAME);
    const telegraphShot = await page.locator('#lab-canvas canvas').screenshot();
    expect(before.cueCount).toBe(0);
    expect(before.announcementText).toBeNull();
    expect(before.berserkActive).toBe(false);
    expect(before.auraGraphicsCount).toBe(0);
    expect(before.movementMultiplier).toBe(1);
    expect(before.meleeMultiplier).toBe(1);
    expect(before.knockbackMultiplier).toBe(1);
    expect(telegraph.cueCount).toBe(1);
    expect(telegraph.announcementText).toBe(ANNOUNCEMENT);

    const telegraphDiff = countChangedPixels(beforeShot, telegraphShot, {
      x: GAME_W * 0.25,
      y: GAME_H * 0.2,
      w: GAME_W * 0.5,
      h: GAME_H * 0.5,
    });
    expect(telegraphDiff).toBeGreaterThan(0.002);

    const resolved = await stepToFrame(page, RESOLUTION_FRAME);
    expect(resolved.cueCount).toBe(0);
    expect(resolved.berserkActive).toBe(true);
    expect(resolved.graphicsCount).toBeGreaterThan(before.graphicsCount);
    expect(resolved.auraGraphicsCount).toBeGreaterThan(0);
    expect(resolved.movementMultiplier).toBeCloseTo(1.4, 6);
    expect(resolved.meleeMultiplier).toBeCloseTo(1.4, 6);
    expect(resolved.knockbackMultiplier).toBeCloseTo(0.35, 6);

    const expiry = await stepToFrame(page, EXPIRY_FRAME);
    expect(expiry.berserkActive).toBe(false);
    expect(expiry.auraGraphicsCount).toBe(0);
    expect(expiry.graphicsCount).toBeLessThan(resolved.graphicsCount);
    expect(expiry.movementMultiplier).toBe(1);
    expect(expiry.meleeMultiplier).toBe(1);
    expect(expiry.knockbackMultiplier).toBe(1);

    const telegraph2 = await stepToFrame(page, SECOND_TELEGRAPH_FRAME);
    expect(telegraph2.cueCount).toBe(1);
    expect(telegraph2.berserkActive).toBe(false);
    expect(telegraph2.movementMultiplier).toBe(1);
    expect(telegraph2.meleeMultiplier).toBe(1);
    expect(telegraph2.knockbackMultiplier).toBe(1);

    const resolved2 = await stepToFrame(page, SECOND_RESOLUTION_FRAME);
    expect(resolved2.cueCount).toBe(0);
    expect(resolved2.berserkActive).toBe(true);
    expect(resolved2.auraGraphicsCount).toBeGreaterThan(0);
    expect(resolved2.movementMultiplier).toBeCloseTo(1.4, 6);
    expect(resolved2.meleeMultiplier).toBeCloseTo(1.4, 6);
    expect(resolved2.knockbackMultiplier).toBeCloseTo(0.35, 6);
  }, 120_000);
});
