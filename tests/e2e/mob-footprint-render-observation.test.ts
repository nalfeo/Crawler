import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`;
const PIXELS_PER_FOOT = 8;

interface ArenaScene {
  settings: {
    roomPresetId: string;
    floorFilter: string;
    enemyPresetId: string;
    playerMode: string;
    simSpeed: number;
  };
  respawn(): void;
  world: { state: string };
  children?: { list?: Array<Record<string, unknown>> };
  textures: { exists(textureKey: string): boolean };
}

interface OpaqueShard {
  readonly spriteName?: string;
  readonly opaqueBounds: {
    readonly height: number;
    readonly canvasHeight: number;
  };
}

function loadShard(spriteName: string): OpaqueShard {
  return JSON.parse(
    readFileSync(
      path.resolve(import.meta.dirname, `../../public/assets/generated/entries/${spriteName}.json`),
      'utf8',
    ),
  ) as OpaqueShard;
}

const SHARD_CACHE = new Map<string, OpaqueShard>();

function shardFor(textureKey: string): OpaqueShard {
  const cached = SHARD_CACHE.get(textureKey);
  if (cached) {
    return cached;
  }
  const shard = loadShard(textureKey);
  SHARD_CACHE.set(textureKey, shard);
  return shard;
}

async function loadArenaLab(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__arenaReady), undefined, {
    timeout: 30_000,
    polling: 200,
  });
}

async function configureArena(
  page: Page,
  floorFilter: 'floor1' | 'floor2',
  enemyPresetId: string,
): Promise<void> {
  await page.evaluate(
    ({ floorFilter, enemyPresetId }) => {
      const scene = (window as { __arenaScene?: ArenaScene }).__arenaScene;
      if (!scene) throw new Error('CombatArenaScene missing');
      window.__arenaReady = false;
      scene.settings.roomPresetId = 'boss-arena';
      scene.settings.floorFilter = floorFilter;
      scene.settings.enemyPresetId = enemyPresetId;
      scene.settings.playerMode = 'observer';
      scene.settings.simSpeed = 1;
      scene.respawn();
    },
    { floorFilter, enemyPresetId },
  );
  await page.waitForFunction(
    (expectedPreset) => {
      const scene = (window as { __arenaScene?: ArenaScene }).__arenaScene;
      return Boolean(window.__arenaReady) && scene?.settings?.enemyPresetId === expectedPreset;
    },
    enemyPresetId,
    { timeout: 30_000, polling: 200 },
  );
}

async function pauseArena(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scene = (window as { __arenaScene?: ArenaScene }).__arenaScene;
    if (!scene) throw new Error('CombatArenaScene missing after respawn');
    scene.world.state = 'paused';
  });
}

async function waitForTexture(page: Page, textureKey: string): Promise<void> {
  await page.waitForFunction(
    (expectedKey) => {
      const scene = (window as { __arenaScene?: ArenaScene }).__arenaScene;
      return scene?.textures.exists(expectedKey) ?? false;
    },
    textureKey,
    { timeout: 30_000, polling: 200 },
  );
}

async function waitForRenderedSprites(
  page: Page,
  texturePrefix: string,
): Promise<Array<{ textureKey: string; displayHeight: number }>> {
  let sprites = await page.evaluate((texturePrefix) => {
    const scene = (window as { __arenaScene?: ArenaScene }).__arenaScene;
    const list = scene?.children?.list ?? [];
    return list.flatMap((obj) => {
      if (obj.type !== 'Image' || obj.visible === false) {
        return [];
      }
      const textureKey = (obj.texture as { key?: string } | undefined)?.key;
      const displayHeight =
        typeof obj.displayHeight === 'number'
          ? obj.displayHeight
          : typeof obj.height === 'number' && typeof obj.scaleY === 'number'
            ? Math.abs(obj.height * obj.scaleY)
            : 0;
      if (
        typeof textureKey !== 'string' ||
        !textureKey.startsWith(texturePrefix) ||
        displayHeight <= 0
      ) {
        return [];
      }
      return [{ textureKey, displayHeight }];
    });
  }, texturePrefix);

  const deadline = Date.now() + 8_000;
  while (sprites.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(100);
    sprites = await page.evaluate((texturePrefix) => {
      const scene = (window as { __arenaScene?: ArenaScene }).__arenaScene;
      const list = scene?.children?.list ?? [];
      return list.flatMap((obj) => {
        if (obj.type !== 'Image' || obj.visible === false) {
          return [];
        }
        const textureKey = (obj.texture as { key?: string } | undefined)?.key;
        const displayHeight =
          typeof obj.displayHeight === 'number'
            ? obj.displayHeight
            : typeof obj.height === 'number' && typeof obj.scaleY === 'number'
              ? Math.abs(obj.height * obj.scaleY)
              : 0;
        if (
          typeof textureKey !== 'string' ||
          !textureKey.startsWith(texturePrefix) ||
          displayHeight <= 0
        ) {
          return [];
        }
        return [{ textureKey, displayHeight }];
      });
    }, texturePrefix);
  }
  return sprites;
}

describe('mob footprint render observation', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('renders live rats and family bosses at authored visible-foot heights in the running arena', async () => {
    await loadArenaLab(page);

    await waitForTexture(page, 'rat-var-9');
    await configureArena(page, 'floor1', 'f1-rats');
    await page.waitForTimeout(800);
    await pauseArena(page);
    const ratSprites = await waitForRenderedSprites(page, 'rat-var-');
    const ratHeights = ratSprites.map(({ textureKey, displayHeight }) => {
      const shard = shardFor(textureKey);
      return (
        (displayHeight * shard.opaqueBounds.height) /
        shard.opaqueBounds.canvasHeight /
        PIXELS_PER_FOOT
      );
    });
    expect(ratHeights.length, 'expected at least one live rat sprite').toBeGreaterThan(0);
    // Live arena captures include the same deterministic squash/stretch motion
    // the shipped game applies to mobs, so the rendered opaque height is allowed
    // a slightly wider band than the pure bridge/unit proof.
    for (const height of ratHeights) {
      expect(height).toBeGreaterThanOrEqual(2.05 * 0.8 - 1e-6);
      expect(height).toBeLessThanOrEqual(2.05 * 1.2 + 1e-6);
    }

    await waitForTexture(page, 'goblin-boss-var-0');
    await configureArena(page, 'floor2', 'f2-goblins');
    await page.waitForTimeout(800);
    await pauseArena(page);
    const bossSprites = await waitForRenderedSprites(page, 'goblin-boss-var-');
    const bossHeights = bossSprites.map(({ textureKey, displayHeight }) => {
      const shard = shardFor(textureKey);
      return (
        (displayHeight * shard.opaqueBounds.height) /
        shard.opaqueBounds.canvasHeight /
        PIXELS_PER_FOOT
      );
    });
    expect(bossHeights.length, 'expected the live family boss sprite').toBeGreaterThan(0);
    for (const height of bossHeights) {
      expect(height).toBeGreaterThanOrEqual(7.0 * 0.8 - 1e-6);
      expect(height).toBeLessThanOrEqual(7.0 * 1.2 + 1e-6);
      expect(height).toBeLessThan(12);
    }

    const avgRatHeight = ratHeights.reduce((sum, value) => sum + value, 0) / ratHeights.length;
    const avgBossHeight = bossHeights.reduce((sum, value) => sum + value, 0) / bossHeights.length;
    expect(avgBossHeight / avgRatHeight).toBeLessThan(4);
    expect(avgBossHeight).toBeGreaterThan(avgRatHeight);
  }, 120_000);
});
