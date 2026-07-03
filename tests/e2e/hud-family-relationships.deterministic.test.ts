import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parsePng, readPixel, colorDist } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';
import type { FamilyRelProbeApi } from '../../src/labs/hud-family-relationships-lab/index.js';

/** Panel background — see HudFamilyRelationships PANEL / lab bg (0x05070f). */
const BG = { r: 0x05, g: 0x07, b: 0x0f };
const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=hud-family-relationships-lab`;

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
      if (colorDist(readPixel(png, x, y), BG) > threshold) nonBg += 1;
    }
  }
  return total > 0 ? nonBg / total : 0;
}

/**
 * Fraction of pixels inside `rect` whose colour differs by more than
 * `threshold` between two screenshots. Used to prove a re-render actually
 * repainted the panel (vs. a stale/first render leaving pixels unchanged).
 */
function changedPixelRatio(
  before: ReturnType<typeof parsePng>,
  after: ReturnType<typeof parsePng>,
  rect: { x: number; y: number; w: number; h: number },
  threshold = 24,
): number {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(before.width - 1, after.width - 1, Math.round(rect.x + rect.w));
  const y1 = Math.min(before.height - 1, after.height - 1, Math.round(rect.y + rect.h));
  let changed = 0;
  let total = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += 1;
      if (colorDist(readPixel(before, x, y), readPixel(after, x, y)) > threshold) changed += 1;
    }
  }
  return total > 0 ? changed / total : 0;
}

async function loadLab(page: Page): Promise<void> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForSelector('#lab-canvas canvas', { timeout: 30_000 });
  await page.waitForFunction(
    () => Boolean((window as { __familyRelProbe?: FamilyRelProbeApi }).__familyRelProbe?.ready()),
    undefined,
    { timeout: 30_000 },
  );
  // Give the panel a few frames to settle into its final layout.
  await page.waitForTimeout(400);
}

describe('HudFamilyRelationships deterministic visual guard', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
    // Load the lab once; both tests operate on this single page. Re-navigating
    // per test triggered a heavy Phaser teardown/reload that could stall
    // `page.goto` on a cold Vite server, so we avoid a second navigation.
    await loadLab(page);
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('renders visible rows in the bottom-right panel region on Floor 2', async () => {
    const canvas = await getCanvasRect(page);
    const buf = await page.screenshot({ type: 'png' });
    const png = parsePng(buf);

    // The panel is anchored bottom-right in the HUD design space:
    //   right edge at GAME_W - 12, bottom edge at GAME_H - 160,
    //   width 232, height ≈ 8 + 22 + 4*(30+4) + 8 = 174.
    const tl = gameToScreen(canvas, GAME_W - 244, GAME_H - 334);
    const br = gameToScreen(canvas, GAME_W - 12, GAME_H - 160);
    const panelRect = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };

    // Below the panel (toward the bottom-center ability bar area) should be
    // mostly empty in the bottom-right column.
    const belowRect = {
      x: tl.x,
      y: br.y + 4,
      w: br.x - tl.x,
      h: Math.max(4, gameToScreen(canvas, GAME_W - 12, GAME_H - 20).y - (br.y + 4)),
    };

    const panelRatio = nonBackgroundRatio(png, panelRect);
    const belowRatio = nonBackgroundRatio(png, belowRect);

    expect(
      panelRatio,
      `family panel must have visible pixels (ratio=${panelRatio.toFixed(3)})`,
    ).toBeGreaterThan(0.15);
    expect(
      belowRatio,
      `region below the family panel must be sparser than the panel (below=${belowRatio.toFixed(3)}, panel=${panelRatio.toFixed(3)})`,
    ).toBeLessThan(panelRatio);
  });

  it('re-renders when relation changes (dirty-flag path repaints the panel)', async () => {
    const canvas = await getCanvasRect(page);
    const tl = gameToScreen(canvas, GAME_W - 244, GAME_H - 334);
    const br = gameToScreen(canvas, GAME_W - 12, GAME_H - 160);
    const panelRect = { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };

    // Establish a known, high-relation baseline (friendly green bars, bosses
    // alive) via the probe, then capture it. Self-contained: no dependence on
    // load-order or a second navigation.
    await page.evaluate(() => {
      const probe = (window as { __familyRelProbe?: FamilyRelProbeApi }).__familyRelProbe;
      if (!probe) throw new Error('__familyRelProbe missing');
      for (let i = 0; i < 4; i += 1) {
        probe.setRelation(i, 90);
        probe.setBossDefeated(i, false);
      }
    });
    await page.waitForTimeout(300);

    const beforePng = parsePng(await page.screenshot({ type: 'png' }));
    const beforeRatio = nonBackgroundRatio(beforePng, panelRect);
    expect(
      beforeRatio,
      `family panel must have visible pixels before mutation (ratio=${beforeRatio.toFixed(3)})`,
    ).toBeGreaterThan(0.15);

    // Push every family into the hate band + mark bosses defeated so the widget
    // swaps to the deep-red bar (shrunk fill), skull glyph, and "At War" tag.
    await page.evaluate(() => {
      const probe = (window as { __familyRelProbe?: FamilyRelProbeApi }).__familyRelProbe;
      if (!probe) throw new Error('__familyRelProbe missing');
      for (let i = 0; i < 4; i += 1) {
        probe.setRelation(i, 5);
        probe.setBossDefeated(i, true);
      }
    });
    await page.waitForTimeout(300);

    const afterPng = parsePng(await page.screenshot({ type: 'png' }));
    const afterRatio = nonBackgroundRatio(afterPng, panelRect);
    expect(
      afterRatio,
      `family panel must still have visible pixels after mutation (ratio=${afterRatio.toFixed(3)})`,
    ).toBeGreaterThan(0.15);

    // The dirty-flag re-render MUST repaint the panel: a stale/first render
    // would leave the pixels unchanged. A substantial per-region delta proves
    // the bars/glyphs/tags were actually redrawn for the new relation state.
    const delta = changedPixelRatio(beforePng, afterPng, panelRect);
    expect(
      delta,
      `dirty-flag re-render must change a meaningful fraction of panel pixels (changed=${delta.toFixed(3)})`,
    ).toBeGreaterThan(0.03);
  });
});
