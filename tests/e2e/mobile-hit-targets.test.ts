/**
 * Mobile tap-target e2e (Item 18b).
 *
 * Verifies the two touch controls flagged in the 2026-06-24 mobile hit-targets
 * handoff are both adequately sized AND functional at the supported landscape
 * viewports, with NO human QA:
 *
 *   • Full-screen minimap overlay close button.
 *   • Level-up +/- stat steppers.
 *
 * For each control, at each viewport, we assert:
 *   1. Size — the authored design-space hit-rect meets a minimum dimension.
 *     The lab runs in Phaser.Scale.FIT (mirroring the shipped game), so the
 *     scene keeps its 1280×720 design space and these rects are stable. The
 *     close button's size scales UP via uiScale on small displays (the actual
 *     fix under test); the +/- buttons use a fixed authored size.
 *   2. Function — tapping the on-screen centre (design→CSS pixel) actually
 *     triggers the control (overlay closes / draft allocation changes),
 *     proving placement and wiring survive both landscape sizes.
 *
 * See tests/e2e/helpers/ui-probe.ts for the coordinate model.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  loadUiProbeLab,
  hideLabChrome,
  getCanvasRect,
  getGameSize,
  boundsCenterScreen,
  probe,
  closeQuietly,
} from './helpers/ui-probe.js';

interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Crawler is landscape-only (portrait shows a rotate interstitial — see
 * `index.html`), so both cases are landscape: the reference phone target
 * (iPhone 13 Pro, 2532×1170 physical = 844×390 CSS px at DPR 3) and a smaller
 * landscape phone that drives `uiScale` to its cap.
 */
const VIEWPORTS: readonly Viewport[] = [
  { name: 'landscape-iphone-13-pro', width: 844, height: 390 },
  { name: 'landscape-compact', width: 667, height: 375 },
];

// Minimum authored (design-space) tap-target dimensions. The close button is
// sized via uiScale (≥52, capped at 72); the +/- steppers use a fixed 34px box.
const MIN_CLOSE_DIM = 44;
const MIN_STEPPER_DIM = 30;

function minDim(b: { width: number; height: number }): number {
  return Math.min(b.width, b.height);
}

// One headless browser shared across both viewports — re-launching Chromium per
// describe block is slow enough to blow the hook timeout on CI.
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await closeQuietly(browser);
});

describe.each(VIEWPORTS)('mobile hit targets ($name)', ({ name, width, height }) => {
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    context = await browser.newContext({ viewport: { width, height } });
    page = await context.newPage();
    await loadUiProbeLab(page);
    await hideLabChrome(page);
  }, 120_000);

  afterAll(async () => {
    await closeQuietly(context);
  });

  it(`minimap close button is tappable and closes the overlay (${name})`, async () => {
    await probe.openMinimapOverlay(page);
    await page.waitForTimeout(300);
    expect(await probe.isMinimapOverlayOpen(page), 'minimap overlay should open').toBe(true);

    const close = await probe.getMinimapCloseBounds(page);
    expect(close, 'minimap overlay close button should exist').not.toBeNull();
    if (!close) return;

    expect(
      minDim(close),
      `close button design size (${minDim(close)}px) should be ≥ ${MIN_CLOSE_DIM}px`,
    ).toBeGreaterThanOrEqual(MIN_CLOSE_DIM);

    const rect = await getCanvasRect(page);
    const game = await getGameSize(page);
    const center = boundsCenterScreen(rect, game, close);
    await page.mouse.click(center.x, center.y);
    await page.waitForTimeout(300);

    expect(
      await probe.isMinimapOverlayOpen(page),
      'tapping the close button should dismiss the minimap overlay',
    ).toBe(false);
  });

  it(`level-up +/- steppers are tappable and adjust the draft (${name})`, async () => {
    await probe.openLevelUp(page, 3);
    await page.waitForTimeout(300);
    expect(await probe.isLevelUpOpen(page), 'level-up panel should open').toBe(true);

    const rows = await probe.getStatControlBounds(page);
    expect(rows.length, 'level-up should expose stat control rows').toBeGreaterThan(0);
    const row = rows[0];
    if (!row) return;

    expect(
      minDim(row.plus),
      `"+" button design size (${minDim(row.plus)}px) should be ≥ ${MIN_STEPPER_DIM}px`,
    ).toBeGreaterThanOrEqual(MIN_STEPPER_DIM);
    expect(
      minDim(row.minus),
      `"−" button design size (${minDim(row.minus)}px) should be ≥ ${MIN_STEPPER_DIM}px`,
    ).toBeGreaterThanOrEqual(MIN_STEPPER_DIM);

    const stat = row.stat;
    expect(await probe.getDraftAllocation(page, stat)).toBe(0);
    expect(await probe.getRemainingPoints(page)).toBe(3);

    const rect = await getCanvasRect(page);
    const game = await getGameSize(page);

    // Tap "+" once → allocation 1, remaining 2.
    await page.mouse.click(...asXY(boundsCenterScreen(rect, game, row.plus)));
    await page.waitForTimeout(250);
    expect(
      await probe.getDraftAllocation(page, stat),
      `tapping "+" should allocate one point to ${stat}`,
    ).toBe(1);
    expect(await probe.getRemainingPoints(page)).toBe(2);

    // Buttons are recreated on every re-render, so re-read the bounds before the
    // second tap. The "−" button only becomes interactive once allocation > 0.
    const rows2 = await probe.getStatControlBounds(page);
    const row2 = rows2[0];
    if (!row2) return;
    await page.mouse.click(...asXY(boundsCenterScreen(rect, game, row2.minus)));
    await page.waitForTimeout(250);
    expect(
      await probe.getDraftAllocation(page, stat),
      `tapping "−" should remove the allocated point from ${stat}`,
    ).toBe(0);
    expect(await probe.getRemainingPoints(page)).toBe(3);
  });
});

/** Spread a {x,y} point into Playwright's mouse.click(x, y) positional args. */
function asXY(p: { x: number; y: number }): [number, number] {
  return [p.x, p.y];
}
