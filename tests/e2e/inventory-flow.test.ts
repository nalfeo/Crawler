/**
 * Inventory-flow e2e (Item 18a).
 *
 * Drives the real InventoryUI + EquipmentUI through the `ui-probe-lab`'s
 * `window.__uiProbe` automation API and verifies the four behaviours called out
 * in the 2026-06-24 inventory handoff, with NO human QA:
 *
 *   1. Item sprites actually render (a generated icon texture, not the text
 *      fallback) — proven by pixel-sampling the charm's magenta probe icon.
 *   2. Tooltips appear on hover and clear on hover-out when not pinned.
 *   3. Tooltips pin on click/tap and survive pointer-out; a second click unpins.
 *   4. The Gear button opens the equipment paper-doll, and equipping the
 *      merchant's charm grants +1 Charisma (effective stat goes up by one).
 *
 * Pixel/coordinate model: see tests/e2e/helpers/ui-probe.ts. The lab runs in
 * Phaser.Scale.FIT, so probe hit-rects are design-space (1280×720) and are
 * converted to CSS pixels via the live canvas rect.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePng, regionContainsColor } from './helpers/pixels.js';
import {
  loadUiProbeLab,
  hideLabChrome,
  getCanvasRect,
  getGameSize,
  designToScreen,
  boundsCenterScreen,
  probe,
  closeQuietly,
} from './helpers/ui-probe.js';

// The probe lab bakes a 64×64 icon texture filled with this magenta (0xff2fd0)
// and injects it as the charm's "approved sprite", so a real image renders in
// the first cell. Detecting it proves the sprite path (not the text fallback);
// the 64×64 source (larger than the ~48px cell target) also exercises the
// resize-to-fit path, so an over-scaled icon can't silently overflow its cell.
const PROBE_ICON_MAGENTA = { r: 0xff, g: 0x2f, b: 0xd0 };

function saveDebugShot(buf: Buffer, filename: string): void {
  try {
    const dir = resolve(process.cwd(), 'tmp', 'e2e-screenshots');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, filename), buf);
  } catch {
    // Best-effort debug artefact only.
  }
}

describe('inventory flow (e2e)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    // 1280×800 leaves the 1280×720 design canvas at ~1:1 under FIT, so cell
    // hit-rects map almost pixel-for-pixel into the screenshot.
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('renders the charm item sprite (generated icon, not text fallback)', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);

    await probe.openInventory(page);
    await page.waitForTimeout(300);
    expect(await probe.isInventoryOpen(page)).toBe(true);

    const cell = await probe.getInventoryCellBounds(page, 0);
    expect(cell, 'first inventory cell should be rendered').not.toBeNull();
    if (!cell) return;

    const rect = await getCanvasRect(page);
    const game = await getGameSize(page);
    const topLeft = designToScreen(rect, game, cell.x, cell.y);
    const region = {
      x: Math.round(topLeft.x),
      y: Math.round(topLeft.y),
      w: Math.round(cell.width * (rect.width / game.width)),
      h: Math.round(cell.height * (rect.height / game.height)),
    };

    const buf = await page.screenshot({ type: 'png' });
    saveDebugShot(buf, 'inventory-sprite.png');
    const png = parsePng(buf);

    expect(
      regionContainsColor(png, region, PROBE_ICON_MAGENTA, 70),
      'Expected the charm cell to contain the magenta generated-sprite icon. ' +
        'If this fails, the inventory is rendering the text fallback instead of the sprite.',
    ).toBe(true);

    // Fit-to-cell: the 64×64 source icon must be resized to fit its cell, not
    // blown up by assuming a fixed 16px source. The old hardcoded `/16` scaled
    // it to 192px (half-width 96px), 3× the 64px cell; the fixed 48px icon has a
    // 24px half-width and can't even reach the cell edge. Sample one cell-width
    // right of the icon centre (32px beyond the cell's right edge) — reachable
    // only by the old overflow, so it must stay clear of the icon's magenta.
    const outsidePt = designToScreen(
      rect,
      game,
      cell.x + cell.width / 2 + cell.width,
      cell.y + cell.height / 2,
    );
    const sample = 12;
    const outsideRegion = {
      x: Math.round(outsidePt.x - sample / 2),
      y: Math.round(outsidePt.y - sample / 2),
      w: sample,
      h: sample,
    };
    expect(
      regionContainsColor(png, outsideRegion, PROBE_ICON_MAGENTA, 70),
      'The charm icon overflowed its cell — it was not resized to fit. ' +
        'InventoryUI must scale generated icons from their real texture size ' +
        '(fitScaleForBox), never assuming a 16px source.',
    ).toBe(false);
  });

  it('shows a tooltip on hover and clears it on hover-out (unpinned)', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openInventory(page);
    await page.waitForTimeout(300);

    const cell = await probe.getInventoryCellBounds(page, 0);
    expect(cell, 'first inventory cell should be rendered').not.toBeNull();
    if (!cell) return;

    const rect = await getCanvasRect(page);
    const game = await getGameSize(page);
    const center = boundsCenterScreen(rect, game, cell);

    await page.mouse.move(center.x, center.y);
    await page.waitForTimeout(250);
    expect(await probe.isTooltipVisible(page), 'tooltip should show on hover').toBe(true);
    expect(await probe.isTooltipPinned(page), 'hover tooltip is not pinned').toBe(false);

    // Move the pointer well away from the cell (top-left of the design space).
    const away = designToScreen(rect, game, 8, 8);
    await page.mouse.move(away.x, away.y);
    await page.waitForTimeout(250);
    expect(
      await probe.isTooltipVisible(page),
      'unpinned tooltip should clear when the pointer leaves the cell',
    ).toBe(false);
  });

  it('pins a tooltip on click and unpins on a second click', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openInventory(page);
    await page.waitForTimeout(300);

    const cell = await probe.getInventoryCellBounds(page, 0);
    expect(cell, 'first inventory cell should be rendered').not.toBeNull();
    if (!cell) return;

    const rect = await getCanvasRect(page);
    const game = await getGameSize(page);
    const center = boundsCenterScreen(rect, game, cell);

    await page.mouse.click(center.x, center.y);
    await page.waitForTimeout(250);
    expect(await probe.isTooltipPinned(page), 'click should pin the tooltip').toBe(true);
    expect(await probe.isTooltipVisible(page), 'pinned tooltip should be visible').toBe(true);

    // A pinned tooltip stays up after the pointer leaves the cell.
    const away = designToScreen(rect, game, 8, 8);
    await page.mouse.move(away.x, away.y);
    await page.waitForTimeout(250);
    expect(await probe.isTooltipVisible(page), 'pinned tooltip should survive pointer-out').toBe(
      true,
    );
    expect(await probe.isTooltipPinned(page), 'tooltip should stay pinned after pointer-out').toBe(
      true,
    );

    // Clicking the same cell again unpins it.
    await page.mouse.click(center.x, center.y);
    await page.waitForTimeout(250);
    expect(await probe.isTooltipPinned(page), 'second click should unpin the tooltip').toBe(false);
  });

  it('opens the equipment paper-doll via the probe (Gear)', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);

    await probe.openEquipment(page);
    await page.waitForTimeout(300);
    expect(await probe.isEquipmentOpen(page), 'equipment paper-doll should open').toBe(true);
    expect(await probe.isInventoryOpen(page), 'opening equipment should also open inventory').toBe(
      true,
    );
  });

  it('selecting an equipment slot applies matching inventory slot filter', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openEquipment(page);
    await page.waitForTimeout(250);

    expect(await probe.selectEquipmentSlot(page, 'mainHand')).toBe(true);
    await page.waitForTimeout(200);
    expect(await probe.getEquipmentSlotFilter(page)).toBe('mainHand');
    expect(await probe.getInventorySlotFilter(page)).toBe('mainHand');
    expect(await probe.getInventoryCellBounds(page, 0)).toBeNull();

    expect(await probe.selectEquipmentSlot(page, 'neck')).toBe(true);
    await page.waitForTimeout(200);
    expect(await probe.getEquipmentSlotFilter(page)).toBe('neck');
    expect(await probe.getInventorySlotFilter(page)).toBe('neck');
    expect(await probe.getInventoryCellBounds(page, 0)).not.toBeNull();
  });

  it('grants +1 Charisma when the merchant charm is equipped', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);

    const before = await probe.getCharisma(page);
    const equipped = await probe.equipCharm(page);
    expect(equipped, 'charm should equip in the safe-room context').toBe(true);

    const after = await probe.getCharisma(page);
    expect(after, 'equipping the charm should raise effective Charisma by exactly 1').toBe(
      before + 1,
    );
  });
});
