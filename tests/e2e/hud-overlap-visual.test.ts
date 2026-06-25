import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parsePng, readPixel, colorDist } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=hud-lab`;
const HUD_BG = { r: 0x05, g: 0x07, b: 0x0f };

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
  await page.goto(LAB_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
  await page.waitForTimeout(2_000);
}

async function setBossFightActive(page: Page, active: boolean): Promise<void> {
  await page.evaluate((nextValue) => {
    const rows = Array.from(document.querySelectorAll('.lil-gui .controller'));
    const row = rows.find((candidate) => {
      const name = candidate.querySelector('.name')?.textContent?.trim();
      return name === 'Boss fight active';
    });
    if (!row) throw new Error('Boss fight active controller not found');
    const input = row.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
    if (!input) throw new Error('Boss fight active checkbox not found');
    if (input.checked !== nextValue) {
      input.click();
    }
  }, active);
}

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
      `expected the vertical gap between timer and boss bar to remain mostly background; got ${gapBandRatio.toFixed(3)}`,
    ).toBeLessThan(0.1);
  });
});
