/**
 * Combat arena lab terrain-render guard (deterministic E2E).
 *
 * Before `buildTerrainLayer` was wired into `ArenaScene.create()`, the entire
 * canvas rendered as pure background (#0a0810) — walls, pillars, corridors, and
 * cave tiles were invisible. This suite boots the lab in a real Phaser/WebGL
 * browser session and asserts that the default boss-arena preset produces
 * non-background pixels in the canvas center, confirming:
 *   - `buildTerrainLayer(this, this.world.floorMap)` was called in `create()`
 *   - the RenderTexture was baked and is depth-sorted beneath ECS entities
 *
 * Why E2E (not unit/headless): terrain baking is Phaser-only — it writes to a
 * WebGL RenderTexture — and cannot be observed in Node. The headless integration
 * test (`tests/unit/combat-arena-lab-wiring.test.ts`) covers the simulation
 * pipeline; this test covers the visual output path (AGENTS.md rule #9 requires
 * before/after capture for visual/runtime changes).
 *
 * Determinism: the boss-arena default always covers the canvas center; the
 * assertion is a conservative pixel-ratio floor (≥1% non-background), not an
 * exact pixel match, making it stable across Phaser's WebGL rasterisation
 * variance and different hardware.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parsePng, readPixel, colorDist } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_W, GAME_H } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=combat-arena-lab`;
/** Phaser scene backgroundColor for the combat arena lab: '#0a0810' */
const ARENA_BG = { r: 0x0a, g: 0x08, b: 0x10 };

declare global {
  interface Window {
    __arenaReady?: boolean;
    __arenaScene?: {
      children?: {
        list?: Array<{ type?: string; depth?: number; setVisible?: (visible: boolean) => void }>;
      };
    };
  }
}

/** Load the lab and wait for ArenaScene.create() to finish (terrain baked). */
async function loadArenaLab(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });

  // Retry across Vite's one-off optimize-deps reload (same pattern as ui-probe.ts).
  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.waitForFunction(() => Boolean(window.__arenaReady), undefined, {
        timeout: 30_000,
        polling: 200,
      });
      // One extra frame so the RenderTexture bake flushes to the display list.
      await page.waitForTimeout(150);
      return;
    } catch {
      if (i < attempts - 1) {
        await page.reload({ waitUntil: 'commit', timeout: 45_000 });
        await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
      }
    }
  }
  throw new Error('ArenaScene.create() never set window.__arenaReady — scene failed to boot');
}

async function getCanvasRect(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return page.evaluate(() => {
    const canvas = document.querySelector('#lab-canvas canvas') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('Phaser canvas not found inside #lab-canvas');
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

async function hideNonTerrainObjects(page: Page): Promise<{ hidden: number; terrain: number }> {
  return page.evaluate(() => {
    const list = window.__arenaScene?.children?.list;
    if (!Array.isArray(list)) {
      throw new Error('CombatArenaScene display list not available');
    }
    let hidden = 0;
    let terrain = 0;
    for (const obj of list) {
      if (obj?.type === 'RenderTexture' && obj?.depth === -20) {
        terrain += 1;
        continue;
      }
      obj?.setVisible?.(false);
      hidden += 1;
    }
    if (terrain === 0) {
      throw new Error('No terrain RenderTexture found in CombatArenaScene display list');
    }
    return { hidden, terrain };
  });
}

/**
 * Count pixels in `rect` whose colour differs from ARENA_BG by more than
 * `threshold` (Euclidean RGB distance). Returns [nonBgCount, totalCount].
 */
function countNonBgPixels(
  png: ReturnType<typeof parsePng>,
  rect: { x: number; y: number; w: number; h: number },
  threshold = 20,
): [number, number] {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(png.width - 1, Math.round(rect.x + rect.w));
  const y1 = Math.min(png.height - 1, Math.round(rect.y + rect.h));
  let nonBg = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      total++;
      if (colorDist(readPixel(png, x, y), ARENA_BG) > threshold) {
        nonBg++;
      }
    }
  }
  return [nonBg, total];
}

describe('Combat arena lab terrain render guard', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    // Match game resolution exactly so Scale.FIT fills the viewport.
    context = await browser.newContext({ viewport: { width: GAME_W, height: GAME_H } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('renders terrain tiles (non-background pixels) after buildTerrainLayer is called', async () => {
    await loadArenaLab(page);
    const hidden = await hideNonTerrainObjects(page);
    await page.waitForTimeout(100);

    const canvasRect = await getCanvasRect(page);
    const screenshot = await page.screenshot();
    const png = parsePng(screenshot);

    // Sample the central 40 % of the canvas after hiding all non-terrain
    // display objects. This makes the assertion terrain-only: a passing sample
    // can only come from the baked RenderTexture, not player/enemy sprites.
    const cx = canvasRect.x + canvasRect.width / 2;
    const cy = canvasRect.y + canvasRect.height / 2;
    const sampleW = canvasRect.width * 0.4;
    const sampleH = canvasRect.height * 0.4;
    const [nonBgCount, totalCount] = countNonBgPixels(png, {
      x: cx - sampleW / 2,
      y: cy - sampleH / 2,
      w: sampleW,
      h: sampleH,
    });
    const ratio = totalCount > 0 ? nonBgCount / totalCount : 0;

    expect(
      ratio,
      `Expected ≥1% non-background pixels in canvas centre but got ${(ratio * 100).toFixed(2)}%. ` +
        `A 0% reading means buildTerrainLayer was not called or its RenderTexture is not ` +
        `visible in the viewport (check depth=-20 and camera bounds). ` +
        `hidden=${JSON.stringify(hidden)} canvas=${JSON.stringify(canvasRect)} ` +
        `sample=${JSON.stringify({ cx, cy, sampleW, sampleH })}`,
    ).toBeGreaterThan(0.01);
  });
});
