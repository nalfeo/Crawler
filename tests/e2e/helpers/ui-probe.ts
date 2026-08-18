/**
 * Shared helpers for the `ui-probe-lab`-driven e2e suites (inventory flow +
 * mobile hit targets).
 *
 * The four UI surfaces under test render to the Phaser canvas, so the lab
 * exposes a typed `window.__uiProbe` automation API (see
 * `src/labs/ui-probe-lab/index.ts`). These helpers load the lab, wait for the
 * probe, and convert the probe's **design-space** (1280×720 scene) hit-rects to
 * the CSS-pixel page coordinates Playwright taps and screenshots sample.
 *
 * The lab runs in `Phaser.Scale.FIT`, so design coords are stable across
 * viewports and the only per-viewport variable is the canvas bounding rect.
 */
import type { Page } from 'playwright';
import { E2E_LAB_BASE_URL } from '../e2e-constants.js';
// Type-only import (erased at runtime — does NOT execute the lab's registerLab).
import type { UiProbeApi } from '../../../src/labs/ui-probe-lab/index.js';
import type { ScreenBounds } from '../../../src/engine/ui-scale.js';
import type { PrimaryStatId } from '../../../src/shared/stats.js';
import type { EquipmentSlotId } from '../../../src/shared/equipment-slots.js';

declare global {
  interface Window {
    __uiProbe?: UiProbeApi;
  }
}

const LAB_ID = 'ui-probe-lab';

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Navigate to the probe lab and wait for `window.__uiProbe.ready()`. */
export async function loadUiProbeLab(page: Page): Promise<void> {
  const url = `${E2E_LAB_BASE_URL}/lab.html?lab=${LAB_ID}`;
  // `commit` (not `networkidle`/`load`): Vite keeps a persistent HMR socket open
  // and may trigger a one-off optimize-deps page reload on the first load of a
  // lab (more likely after a different lab was served earlier in the run), so
  // waiting on network state is flaky. We commit the navigation and poll for the
  // probe's ready flag instead. waitForFunction re-binds across Vite's own
  // self-reload; the bounded re-navigation below is the recovery path if an
  // optimize/reload cycle wedges or outlasts a single polling window.
  await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
  const windows = 3;
  for (let i = 0; i < windows; i += 1) {
    try {
      await page.waitForFunction(() => Boolean(window.__uiProbe?.ready()), undefined, {
        timeout: 30_000,
        polling: 200,
      });
      // A few frames of headroom so the first sync()/render pass settles.
      await page.waitForTimeout(600);
      return;
    } catch (err) {
      if (i === windows - 1) throw err;
      await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
    }
  }
}

/**
 * Hide the lab page chrome (header + controls sidebar) so the Phaser canvas
 * grows to fill the viewport. Geometry helpers read the live rect, so this is
 * only about giving the canvas (and thus tap targets) more room.
 */
export async function hideLabChrome(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getElementById('app-header')?.style.setProperty('display', 'none');
    const controls = document.getElementById('lab-controls');
    if (controls) controls.style.display = 'none';
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(400);
}

/** Live CSS-pixel bounding rect of the Phaser canvas. */
export async function getCanvasRect(page: Page): Promise<CanvasRect> {
  return page.evaluate(() => {
    const canvas = document.querySelector('#lab-canvas canvas') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('Phaser canvas not found in #lab-canvas');
    const r = canvas.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/** The lab scene's design size (1280×720 under FIT). */
export async function getGameSize(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => {
    if (!window.__uiProbe) throw new Error('__uiProbe not ready');
    return window.__uiProbe.getGameSize();
  });
}

/** Convert a design-space (scene) coordinate to a CSS-pixel page coordinate. */
export function designToScreen(
  rect: CanvasRect,
  gameSize: { width: number; height: number },
  dx: number,
  dy: number,
): Point {
  return {
    x: rect.x + dx * (rect.width / gameSize.width),
    y: rect.y + dy * (rect.height / gameSize.height),
  };
}

/** Center of a design-space rect, in CSS-pixel page coordinates. */
export function boundsCenterScreen(
  rect: CanvasRect,
  gameSize: { width: number; height: number },
  b: ScreenBounds,
): Point {
  return designToScreen(rect, gameSize, b.x + b.width / 2, b.y + b.height / 2);
}

/** Typed wrappers around the in-page `window.__uiProbe` automation API. */
export const probe = {
  openInventory: (page: Page) => page.evaluate(() => window.__uiProbe!.openInventory()),
  closeOverlays: (page: Page) => page.evaluate(() => window.__uiProbe!.closeOverlays()),
  isInventoryOpen: (page: Page) => page.evaluate(() => window.__uiProbe!.isInventoryOpen()),
  getInventoryCellBounds: (page: Page, index: number) =>
    page.evaluate((i) => window.__uiProbe!.getInventoryCellBounds(i), index),
  getInventoryCellIndexForItem: (page: Page, itemId: string) =>
    page.evaluate((id) => window.__uiProbe!.getInventoryCellIndexForItem(id), itemId),
  isTooltipVisible: (page: Page) => page.evaluate(() => window.__uiProbe!.isTooltipVisible()),
  isTooltipPinned: (page: Page) => page.evaluate(() => window.__uiProbe!.isTooltipPinned()),

  openEquipment: (page: Page) => page.evaluate(() => window.__uiProbe!.openEquipment()),
  openEquipmentOnly: (page: Page) => page.evaluate(() => window.__uiProbe!.openEquipmentOnly()),
  isEquipmentOpen: (page: Page) => page.evaluate(() => window.__uiProbe!.isEquipmentOpen()),
  getEquipmentPanelBounds: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentPanelBounds()),
  getEquipmentHeaderBounds: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentHeaderBounds()),
  getEquipmentDollBounds: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentDollBounds()),
  getEquipmentSlotBounds: (page: Page, slotId: EquipmentSlotId) =>
    page.evaluate((slot) => window.__uiProbe!.getEquipmentSlotBounds(slot), slotId),
  getEquipmentTooltipBounds: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentTooltipBounds()),
  isEquipmentTooltipTopmost: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.isEquipmentTooltipTopmost()),
  // Integrated equippable-bag column (inside the equipment panel).
  getEquipmentBagItemIds: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentBagItemIds()),
  getEquipmentBagCellBounds: (page: Page, index: number) =>
    page.evaluate((i) => window.__uiProbe!.getEquipmentBagCellBounds(i), index),
  getEquipmentBagColumnBounds: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentBagColumnBounds()),
  scrollEquipmentBag: (page: Page, rows: number) =>
    page.evaluate((r) => window.__uiProbe!.scrollEquipmentBag(r), rows),
  getEquipmentBagScrollRow: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentBagScrollRow()),
  getEquipmentBagMaxScrollRow: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentBagMaxScrollRow()),
  seedOverflowBag: (page: Page, count: number) =>
    page.evaluate((c) => window.__uiProbe!.seedOverflowBag(c), count),
  previewEquipmentBagItem: (page: Page, itemId: string | null) =>
    page.evaluate((id) => window.__uiProbe!.previewEquipmentBagItem(id), itemId),
  equipFromEquipmentBag: (page: Page, itemId: string) =>
    page.evaluate((id) => window.__uiProbe!.equipFromEquipmentBag(id), itemId),
  unequipEquipmentSlot: (page: Page, slotId: EquipmentSlotId) =>
    page.evaluate((slot) => window.__uiProbe!.unequipEquipmentSlot(slot), slotId),
  getEquipmentStatsBounds: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentStatsBounds()),
  getEquipmentInspectorBounds: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentInspectorBounds()),
  getEquipmentTextRuns: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentTextRuns()),
  getEquipmentTextRasterMetadata: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentTextRasterMetadata()),
  getEquipmentPreviewTargetSlots: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentPreviewTargetSlots()),
  getEquipmentTargetMarkerBounds: (page: Page, slotId: EquipmentSlotId) =>
    page.evaluate((slot) => window.__uiProbe!.getEquipmentTargetMarkerBounds(slot), slotId),
  isEquipmentTooltipVisible: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.isEquipmentTooltipVisible()),
  selectEquipmentSlot: (page: Page, slotId: EquipmentSlotId | null) =>
    page.evaluate((slot) => window.__uiProbe!.selectEquipmentSlot(slot), slotId),
  previewEquipmentSlot: (page: Page, slotId: EquipmentSlotId) =>
    page.evaluate((slot) => window.__uiProbe!.previewEquipmentSlot(slot), slotId),
  getEquipmentSlotFilter: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getEquipmentSlotFilter()),
  getInventorySlotFilter: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getInventorySlotFilter()),
  getCharisma: (page: Page) => page.evaluate(() => window.__uiProbe!.getCharisma()),
  equipCharm: (page: Page) => page.evaluate(() => window.__uiProbe!.equipCharm()),
  equipInventoryItem: (page: Page, itemId: string) =>
    page.evaluate((id) => window.__uiProbe!.equipInventoryItem(id), itemId),
  seedAllGear: (page: Page) => page.evaluate(() => window.__uiProbe!.seedAllGear()),
  getEquippedSlotIds: (page: Page) => page.evaluate(() => window.__uiProbe!.getEquippedSlotIds()),

  openMinimapOverlay: (page: Page) => page.evaluate(() => window.__uiProbe!.openMinimapOverlay()),
  isMinimapOverlayOpen: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.isMinimapOverlayOpen()),
  getMinimapCloseBounds: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getMinimapCloseBounds()),
  getMinimapDockedBounds: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getMinimapDockedBounds()),

  openLevelUp: (page: Page, points: number) =>
    page.evaluate((p) => window.__uiProbe!.openLevelUp(p), points),
  isLevelUpOpen: (page: Page) => page.evaluate(() => window.__uiProbe!.isLevelUpOpen()),
  getStatControlBounds: (page: Page) =>
    page.evaluate(() => window.__uiProbe!.getStatControlBounds()),
  getDraftAllocation: (page: Page, stat: PrimaryStatId) =>
    page.evaluate((s) => window.__uiProbe!.getDraftAllocation(s), stat),
  getRemainingPoints: (page: Page) => page.evaluate(() => window.__uiProbe!.getRemainingPoints()),
};

/**
 * Best-effort teardown for a Playwright Browser/BrowserContext. e2e teardown
 * must never fail a suite or hang: under heavy CI/dev-box load `close()` can be
 * slow (or, rarely, wedge) even though the work under test already completed by
 * the time `afterAll` runs. Race the close against a bounded timer and swallow
 * errors so the hook always settles well within its budget.
 */
export async function closeQuietly(closer?: { close(): Promise<unknown> }): Promise<void> {
  if (!closer) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closer.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 15_000);
      }),
    ]);
  } catch {
    // Teardown is best-effort — never fail a passing suite on cleanup.
  } finally {
    if (timer) clearTimeout(timer);
  }
}
