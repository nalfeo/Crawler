/**
 * Landscape safe-area e2e gate (iPhone 13 Pro, 2532×1170 physical).
 *
 * Crawler is landscape-only and targets a notched phone, so every screen-space
 * surface must stay clear of the display cutout and the home indicator. This
 * suite pins that deterministically at the reference viewport — 844×390 CSS px
 * at DPR 3 — against the REAL `MainGameScene` booted through the shipped floor
 * bootstrap (`main-scene-probe-lab`), not an isolated HUD lab: a lab-only pass
 * could not prove the shipped scene wires the insets in.
 *
 * Desktop Chromium always reports `env(safe-area-inset-*)` as zero, so the test
 * injects the real device's insets through the `--crawler-safe-area-inset-*`
 * custom properties the HTML entry points publish — the exact same channel the
 * engine reads on a physical device (see `src/engine/safe-area.ts`).
 *
 * Regression pinned: before this gate, the 21px home-indicator band covered the
 * bottom of the canvas (the side bands fall inside the pillarbox) and cut
 * through the loadout modal's footer hint and the bottom HUD cluster.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

/** iPhone 13 Pro landscape: 2532×1170 physical = 844×390 CSS px at DPR 3. */
const VIEWPORT = { width: 844, height: 390 };
const DEVICE_SCALE_FACTOR = 3;

/** Real iPhone 13 Pro landscape insets: notch on one long edge, home indicator. */
const DEVICE_INSETS = { top: 0, right: 47, bottom: 21, left: 47 };

/**
 * Surfaces are allowed to touch the safe boundary exactly; only a real
 * intrusion fails. One design pixel of slack absorbs rounding in the layout
 * math (`Math.round` on panel positions, fractional canvas widths).
 */
const INTRUSION_TOLERANCE_PX = 1;

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Publish a physical device's safe-area insets before any script runs, so the
 * scene boots with them exactly as it would on the device. Injecting after boot
 * would only be picked up on the next ScaleManager resize.
 */
async function injectSafeAreaInsets(page: Page, insets: typeof DEVICE_INSETS): Promise<void> {
  await page.addInitScript((values) => {
    const apply = (): void => {
      const style = document.createElement('style');
      style.textContent = `:root {
        --crawler-safe-area-inset-top: ${values.top}px;
        --crawler-safe-area-inset-right: ${values.right}px;
        --crawler-safe-area-inset-bottom: ${values.bottom}px;
        --crawler-safe-area-inset-left: ${values.left}px;
      }`;
      document.head.appendChild(style);
    };
    if (document.head) {
      apply();
    } else {
      document.addEventListener('DOMContentLoaded', apply, { once: true });
    }
  }, insets);
}

/** Hide the lab page chrome so the canvas fills the viewport like the game. */
async function hideLabChrome(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('app-header')?.style.setProperty('display', 'none');
    document.getElementById('lab-controls')?.style.setProperty('display', 'none');
    document.getElementById('controls-toggle')?.style.setProperty('display', 'none');
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(400);
}

/** How far a rect intrudes past each edge of the design-space safe rect. */
function intrusion(
  bounds: Bounds,
  insets: { top: number; right: number; bottom: number; left: number },
): { top: number; right: number; bottom: number; left: number } {
  return {
    top: insets.top - bounds.y,
    left: insets.left - bounds.x,
    right: bounds.x + bounds.width - (GAME_W - insets.right),
    bottom: bounds.y + bounds.height - (GAME_H - insets.bottom),
  };
}

/** Worst single-edge intrusion, in design pixels (≤0 means fully inside). */
function worstIntrusion(
  bounds: Bounds,
  insets: { top: number; right: number; bottom: number; left: number },
): number {
  const edges = intrusion(bounds, insets);
  return Math.max(edges.top, edges.right, edges.bottom, edges.left);
}

/** Bottom edge of one named probed surface, in design pixels. */
function bottomEdgeOf(
  layout: { surfaces: Array<{ name: string; bounds: Bounds }> },
  name: string,
): number {
  const surface = layout.surfaces.find((entry) => entry.name === name);
  if (!surface) throw new Error(`safe-area probe surface not found: ${name}`);
  return surface.bounds.y + surface.bounds.height;
}

/**
 * The bottom-anchored ability-bar group — the HUD cluster nearest the home
 * indicator, and therefore the one whose shift proves the wiring is live.
 */
const BOTTOM_ANCHORED_SURFACE = 'bottomCenter';

describe('landscape safe-area layout at 844×390 (iPhone 13 Pro)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  /** Bottom edge of the loadout modal with no insets — the pre-fix layout. */
  let baselineModalBottom: number;
  /** Bottom edge of the bottom-anchored HUD group with no insets. */
  let baselineHudBottom: number;

  /** Boot the real scene at the reference viewport, optionally with insets. */
  async function bootScene(withInsets: boolean): Promise<Page> {
    const next = await context.newPage();
    if (withInsets) {
      await injectSafeAreaInsets(next, DEVICE_INSETS);
    }
    await loadMainSceneProbeLab(next);
    await hideLabChrome(next);
    return next;
  }

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
    });

    // Baseline: identical viewport, zero insets — captures the layout the
    // device would have used before the safe-area work, so the assertions below
    // prove a real shift rather than a coincidentally-safe layout.
    const baselinePage = await bootScene(false);
    const baselineInsets = await mainSceneProbe.getSafeAreaLayout(baselinePage);
    expect(baselineInsets.insets.bottom).toBe(0);
    const baselineModal = await mainSceneProbe.getModalPickerLayout(baselinePage);
    expect(baselineModal).not.toBeNull();
    baselineModalBottom = baselineModal!.panel.y + baselineModal!.panel.height;
    await mainSceneProbe.resolveLoadout(baselinePage);
    await baselinePage.waitForTimeout(800);
    baselineHudBottom = bottomEdgeOf(
      await mainSceneProbe.getSafeAreaLayout(baselinePage),
      BOTTOM_ANCHORED_SURFACE,
    );
    await baselinePage.close();

    page = await bootScene(true);
  }, 240_000);

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('absorbs the notch bands in the pillarbox and keeps only the bottom inset', async () => {
    const layout = await mainSceneProbe.getSafeAreaLayout(page);

    // The 16:9 canvas pillarboxes to ~693×390 inside an 844px-wide viewport, so
    // ~75px of black bar on each side swallows the 47px notch band entirely.
    expect(layout.insets.left).toBe(0);
    expect(layout.insets.right).toBe(0);
    expect(layout.insets.top).toBe(0);
    // 21 CSS px over a 390px-tall canvas ≈ 38.8 design px of home indicator.
    expect(layout.insets.bottom).toBeGreaterThan(30);
    expect(layout.insets.bottom).toBeLessThan(45);
  });

  it('keeps the opening loadout modal clear of the home-indicator band', async () => {
    const modal = await mainSceneProbe.getModalPickerLayout(page);
    expect(modal).not.toBeNull();

    const layout = await mainSceneProbe.getSafeAreaLayout(page);
    // Regression pin: without insets the panel ran past the safe boundary, so
    // the modal must have actually moved up rather than already fitting.
    expect(baselineModalBottom).toBeGreaterThan(GAME_H - layout.insets.bottom);
    expect(modal!.panel.y + modal!.panel.height).toBeLessThan(baselineModalBottom);
    // The footer hint line was the surface the band cut through before the fix.
    expect(worstIntrusion(modal!.footer, layout.insets)).toBeLessThanOrEqual(
      INTRUSION_TOLERANCE_PX,
    );
    expect(worstIntrusion(modal!.panel, layout.insets)).toBeLessThanOrEqual(INTRUSION_TOLERANCE_PX);
  });

  it('keeps every edge-anchored HUD surface inside the safe rect in-game', async () => {
    await mainSceneProbe.resolveLoadout(page);
    await page.waitForTimeout(800);

    const layout = await mainSceneProbe.getSafeAreaLayout(page);
    expect(layout.surfaces.length).toBeGreaterThan(0);

    const intruding = layout.surfaces
      .map((surface) => ({
        name: surface.name,
        overshoot: worstIntrusion(surface.bounds, layout.insets),
      }))
      .filter((entry) => entry.overshoot > INTRUSION_TOLERANCE_PX);

    expect(intruding).toEqual([]);

    // The bottom HUD cluster must have actually been lifted by the inset, so a
    // future regression that drops the wiring cannot pass by sitting close to
    // (but inside) the boundary.
    expect(bottomEdgeOf(layout, BOTTOM_ANCHORED_SURFACE)).toBeCloseTo(
      baselineHudBottom - layout.insets.bottom,
      0,
    );
  });
});

/**
 * Landscape-only enforcement. Web content cannot lock orientation on iOS, so
 * portrait is handled by an interstitial in the shipped game shell
 * (`index.html`). Gated on `pointer: coarse`, so a narrow *desktop* window must
 * be unaffected — that distinction is what this suite pins.
 */
describe('portrait rotate interstitial', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  async function readShellState(
    viewport: { width: number; height: number },
    hasTouch: boolean,
  ): Promise<{ noticeShown: boolean; gameVisible: boolean }> {
    const context = await browser.newContext({ viewport, hasTouch, isMobile: hasTouch });
    const page = await context.newPage();
    try {
      // Only the shell markup/CSS is under test here, so `commit` is enough —
      // no need to wait for Phaser to boot the game.
      await page.goto(`${E2E_LAB_BASE_URL}/`, { waitUntil: 'commit', timeout: 45_000 });
      await page.waitForSelector('#rotate-notice', { state: 'attached', timeout: 30_000 });
      // Awaited (not returned) so the `finally` below cannot close the context
      // out from under an in-flight evaluate.
      return await page.evaluate(() => {
        const notice = document.getElementById('rotate-notice');
        const game = document.getElementById('game-container');
        return {
          noticeShown: notice ? getComputedStyle(notice).display !== 'none' : false,
          gameVisible: game ? getComputedStyle(game).visibility !== 'hidden' : false,
        };
      });
    } finally {
      await context.close();
    }
  }

  it('covers the game with a rotate prompt on a portrait touch device', async () => {
    const state = await readShellState({ width: 390, height: 844 }, true);

    expect(state.noticeShown).toBe(true);
    expect(state.gameVisible).toBe(false);
  });

  it('stays out of the way on the landscape touch target', async () => {
    const state = await readShellState(VIEWPORT, true);

    expect(state.noticeShown).toBe(false);
    expect(state.gameVisible).toBe(true);
  });

  it('never blocks a narrow desktop window (fine pointer)', async () => {
    const state = await readShellState({ width: 500, height: 900 }, false);

    expect(state.noticeShown).toBe(false);
    expect(state.gameVisible).toBe(true);
  });
});
