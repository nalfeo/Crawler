import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parsePng, readPixel, colorDist } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';
import type { HudProbeApi } from '../../src/labs/hud-lab/index.js';
const HUD_BG = { r: 0x05, g: 0x07, b: 0x0f };
const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=hud-lab`;

interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
}

async function getCanvasRect(page: Page): Promise<CanvasRect> {
  return page.evaluate(() => {
    const canvas = document.querySelector('#lab-canvas canvas') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('Phaser canvas not found in #lab-canvas');
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

function gameToScreen(rect: CanvasRect, gx: number, gy: number): { x: number; y: number } {
  return {
    x: Math.round(rect.x + gx * (rect.width / GAME_W)),
    y: Math.round(rect.y + gy * (rect.height / GAME_H)),
  };
}

function boundsToScreen(rect: CanvasRect, bounds: Bounds): Bounds {
  return {
    x: rect.x + bounds.x * (rect.width / GAME_W),
    y: rect.y + bounds.y * (rect.height / GAME_H),
    width: bounds.width * (rect.width / GAME_W),
    height: bounds.height * (rect.height / GAME_H),
    text: bounds.text,
  };
}

function contains(outer: Bounds, inner: Bounds, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  );
}

function overlaps(a: Bounds, b: Bounds, tolerance = 0.5): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > tolerance &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > tolerance
  );
}

function nonBackgroundRatio(
  png: ReturnType<typeof parsePng>,
  rect: { x: number; y: number; w: number; h: number },
  threshold = 20,
): number {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(png.width - 1, Math.round(rect.x + rect.w));
  const y1 = Math.min(png.height - 1, Math.round(rect.y + rect.h));
  let nonBg = 0;
  let total = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += 1;
      if (colorDist(readPixel(png, x, y), HUD_BG) > threshold) {
        nonBg += 1;
      }
    }
  }
  return total > 0 ? nonBg / total : 0;
}

async function loadHudLab(page: Page): Promise<void> {
  // `commit` (not `networkidle`): Vite keeps a persistent HMR socket open and may
  // trigger a one-off optimize-deps reload on first lab load, so waiting on
  // network state is flaky. We commit the navigation and gate on the canvas +
  // `__hudProbe.ready()` below, matching tests/e2e/helpers/ui-probe.ts.
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
  await page.waitForFunction(
    () => Boolean((window as { __hudProbe?: HudProbeApi }).__hudProbe?.ready()),
    undefined,
    {
      timeout: 30_000,
    },
  );
  await page.waitForTimeout(500);
}

async function setBossFightActive(page: Page, active: boolean): Promise<void> {
  await page.evaluate((next) => {
    const probe = (window as { __hudProbe?: HudProbeApi }).__hudProbe;
    if (!probe) throw new Error('__hudProbe not available');
    probe.setBossFightActive(next);
  }, active);
}

async function hideLabShell(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('app-header')?.style.setProperty('display', 'none');
    document.getElementById('lab-controls')?.style.setProperty('display', 'none');
    document.getElementById('controls-toggle')?.style.setProperty('display', 'none');
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(500);
}

async function loadLootSkillProbe(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await loadHudLab(page);
    const available = await page.evaluate(
      () =>
        typeof (window as { __hudProbe?: HudProbeApi }).__hudProbe?.setLootSkillStressState ===
        'function',
    );
    if (available) return;
    await page.goto('about:blank', { waitUntil: 'commit' });
  }
  throw new Error('Current hud-lab stress probe did not load after three attempts');
}

describe('loot and skill HUD containment', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it.each([
    { width: 1280, height: 720 },
    { width: 960, height: 540 },
  ])(
    'contains stress text and stays clear of adjacent HUD at $width×$height',
    async ({ width, height }) => {
      const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      try {
        await loadLootSkillProbe(page);
        await hideLabShell(page);
        const canvas = await getCanvasRect(page);
        expect(canvas).toEqual({ x: 0, y: 0, width, height });

        const layout = await page.evaluate(() => {
          const probe = (window as { __hudProbe?: HudProbeApi }).__hudProbe;
          if (!probe) throw new Error('__hudProbe not available');
          probe.setLootSkillStressState();
          return probe.getLootSkillLayout();
        });
        await page.waitForTimeout(200);

        const viewport: Bounds = { x: 0, y: 0, width, height };
        const regions = Object.fromEntries(
          Object.entries(layout.regions).map(([name, bounds]) => [
            name,
            boundsToScreen(canvas, bounds),
          ]),
        );
        const region = (name: string): Bounds => {
          const result = regions[name];
          if (!result) throw new Error(`Missing HUD region: ${name}`);
          return result;
        };

        for (const [name, bounds] of Object.entries(regions)) {
          expect(contains(viewport, bounds), `${name} must remain inside the viewport`).toBe(true);
        }
        expect(
          contains(region('hud-loot-gold-value-bounds'), region('hud-loot-gold-text')),
          'gold text must remain inside its reserved value column',
        ).toBe(true);
        expect(
          contains(region('hud-loot-junk-value-bounds'), region('hud-loot-junk-text')),
          'junk text must remain inside its reserved value column',
        ).toBe(true);

        for (const row of ['class', 'type']) {
          const name = region(`hud-skill-${row}-name-text`);
          const level = region(`hud-skill-${row}-level`);
          expect(
            name.x + name.width,
            `${row} skill name must end before its level column`,
          ).toBeLessThanOrEqual(level.x - 3);
        }
        expect(region('hud-skill-type-name-text').text).toMatch(/…$/);

        const lootPanel = region('hud-loot-panel-bounds');
        const skillPanel = region('hud-skill-panel-bounds');
        expect(overlaps(lootPanel, skillPanel), 'loot and skill panels must not overlap').toBe(
          false,
        );

        for (const bounds of [...layout.adjacentRegions, ...layout.otherHudGroups]) {
          const adjacent = boundsToScreen(canvas, bounds);
          expect(overlaps(lootPanel, adjacent), 'loot panel must not overlap adjacent HUD').toBe(
            false,
          );
          expect(overlaps(skillPanel, adjacent), 'skill panel must not overlap adjacent HUD').toBe(
            false,
          );
        }
      } finally {
        await closeQuietly(context);
      }
    },
    120_000,
  );
});

describe('hud ability bar visual regression guard (mobile scale)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    // 800×450 is 16:9 like the design canvas (1280×720), so Phaser FIT fills the
    // viewport exactly. The resulting ui-scale is max(1280/800, 720/450) = 1.6,
    // which exceeds ABILITY_BAR_MAX_SCALE (1.2) and exercises the scale cap.
    context = await browser.newContext({ viewport: { width: 800, height: 450 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('ability bar stays visible with ABILITY_BAR_MAX_SCALE cap applied', async () => {
    await loadHudLab(page);
    await page.waitForTimeout(400);

    const buf = await page.screenshot({ type: 'png' });
    const png = parsePng(buf);
    const canvas = await getCanvasRect(page);

    const scaleX = canvas.width / GAME_W;
    const centerX = gameToScreen(canvas, GAME_W / 2, 0).x;
    const bandWidth = Math.round(220 * scaleX);

    const band = (topGy: number, bottomGy: number) => {
      const top = gameToScreen(canvas, 0, topGy).y;
      const bottom = gameToScreen(canvas, 0, bottomGy).y;
      return {
        x: centerX - Math.floor(bandWidth / 2),
        y: top,
        w: bandWidth,
        h: Math.max(1, bottom - top),
      };
    };

    // At ABILITY_BAR_MAX_SCALE=1.2 the bottomCenter container sits at
    // y = GAME_H*(1-1.2) = -144. The ability bar title+slots (design y 550–636)
    // render at scene y ≈ 516–619.
    const abilityBandRatio = nonBackgroundRatio(png, band(510, 625));
    // The region between the top HUD and the ability bar should be mostly empty.
    const midGapRatio = nonBackgroundRatio(png, band(430, 490));

    expect(abilityBandRatio, 'ability bar must be visible at mobile scale').toBeGreaterThan(0.1);
    expect(
      midGapRatio,
      `mid-screen gap must be sparser than ability bar (gap=${midGapRatio.toFixed(3)}, bar=${abilityBandRatio.toFixed(3)})`,
    ).toBeLessThan(abilityBandRatio * 0.5);
  });
});

describe('hud visual regression overlap guard', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('keeps a visible gap between floor timer and boss bar when boss fight is active', async () => {
    await loadHudLab(page);
    await setBossFightActive(page, true);
    await page.waitForTimeout(400);

    const buf = await page.screenshot({ type: 'png' });
    const png = parsePng(buf);
    const canvas = await getCanvasRect(page);

    const scaleX = canvas.width / GAME_W;
    const centerX = gameToScreen(canvas, GAME_W / 2, 0).x;
    const bandWidth = Math.round(220 * scaleX);

    const band = (topGy: number, bottomGy: number) => {
      const top = gameToScreen(canvas, 0, topGy).y;
      const bottom = gameToScreen(canvas, 0, bottomGy).y;
      return {
        x: centerX - Math.floor(bandWidth / 2),
        y: top,
        w: bandWidth,
        h: Math.max(1, bottom - top),
      };
    };

    const timerBandRatio = nonBackgroundRatio(png, band(28, 48));
    const gapBandRatio = nonBackgroundRatio(png, band(53, 58));
    const bossBandRatio = nonBackgroundRatio(png, band(62, 78));

    expect(timerBandRatio, 'expected visible floor timer pixels in timer band').toBeGreaterThan(
      0.25,
    );
    expect(bossBandRatio, 'expected visible boss bar pixels in boss band').toBeGreaterThan(0.25);
    expect(
      gapBandRatio,
      `expected gap band to be visibly sparser than timer band (gap=${gapBandRatio.toFixed(3)}, timer=${timerBandRatio.toFixed(3)})`,
    ).toBeLessThan(timerBandRatio * 0.8);
    expect(
      gapBandRatio,
      `expected gap band to be visibly sparser than boss band (gap=${gapBandRatio.toFixed(3)}, boss=${bossBandRatio.toFixed(3)})`,
    ).toBeLessThan(bossBandRatio * 0.8);
  });
});
