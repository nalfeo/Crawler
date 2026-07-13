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

function expectContained(outer: CanvasRect, inner: CanvasRect, message: string): void {
  expect(inner.x, `${message}: left edge`).toBeGreaterThanOrEqual(outer.x);
  expect(inner.y, `${message}: top edge`).toBeGreaterThanOrEqual(outer.y);
  expect(inner.x + inner.width, `${message}: right edge`).toBeLessThanOrEqual(
    outer.x + outer.width,
  );
  expect(inner.y + inner.height, `${message}: bottom edge`).toBeLessThanOrEqual(
    outer.y + outer.height,
  );
}

function overlapArea(a: CanvasRect, b: CanvasRect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

describe('encounter HUD responsive geometry', () => {
  const viewports = [
    { name: 'desktop', width: 1280, height: 720 },
    { name: 'compact-landscape', width: 960, height: 540 },
  ] as const;
  const presets = [
    'timer-normal',
    'timer-urgent',
    'boss-floor1-long',
    'boss-floor2-long',
    'banner-long',
    'banner-queue',
    'simultaneous',
  ] as const;

  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  for (const viewport of viewports) {
    it(`contains all text and separates encounter surfaces at ${viewport.width}x${viewport.height}`, async () => {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
      });
      try {
        for (const preset of presets) {
          const page = await context.newPage();
          await loadHudLab(page);
          const bounds = await page.evaluate((nextPreset) => {
            const probe = (window as { __hudProbe?: HudProbeApi }).__hudProbe;
            if (!probe) throw new Error('__hudProbe not available');
            probe.setEncounterPreset(nextPreset);
            probe.freezeAnimations();
            return probe.getEncounterBounds();
          }, preset);

          const canvasBounds = { x: 0, y: 0, width: GAME_W, height: GAME_H };
          const panels = [
            ['timer', bounds.timerPanel],
            ['boss', bounds.bossPanel],
            ['announcement', bounds.announcementPanel],
            ['quest', bounds.questPanel],
            ['minimap', bounds.minimap],
          ].filter((entry): entry is [string, CanvasRect] => entry[1] !== null);

          for (const [name, panel] of panels) {
            expectContained(canvasBounds, panel, `${viewport.name}/${preset}/${name} canvas`);
          }
          expectContained(
            bounds.timerPanel,
            bounds.timerText,
            `${viewport.name}/${preset}/timer text`,
          );
          if (bounds.bossPanel && bounds.bossText) {
            expectContained(
              bounds.bossPanel,
              bounds.bossText,
              `${viewport.name}/${preset}/boss text`,
            );
          }
          if (bounds.announcementPanel && bounds.announcementText) {
            expectContained(
              bounds.announcementPanel,
              bounds.announcementText,
              `${viewport.name}/${preset}/announcement text`,
            );
          }
          for (let i = 0; i < panels.length; i += 1) {
            for (let j = i + 1; j < panels.length; j += 1) {
              expect(
                overlapArea(panels[i]![1], panels[j]![1]),
                `${viewport.name}/${preset}: ${panels[i]![0]} overlaps ${panels[j]![0]}`,
              ).toBe(0);
            }
          }
          await page.close();
        }
      } finally {
        await context.close();
      }
    }, 120_000);
  }
});
