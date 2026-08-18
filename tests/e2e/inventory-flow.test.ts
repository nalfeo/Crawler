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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parsePng, regionContainsColor } from './helpers/pixels.js';
import {
  captureArtifactPath,
  captureEquipmentPanel,
  containsWithin,
  MIN_READABLE_GLYPH_PX,
  overlapArea,
  physicalGlyphPx,
  seedEquipmentDecisionState,
} from './helpers/equipment-capture.js';
import { SLOT_REGISTRY } from '../../src/shared/equipment-slots.js';
import { MERCHANTS_CHARM_DEF } from '../../src/shared/equipmentDefs.js';
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
import type { ScreenBounds } from '../../src/engine/ui-scale.js';

// The probe lab bakes a 64×64 icon texture filled with this magenta (0xff2fd0)
// and injects it as the charm's "approved sprite", so a real image renders in
// the first cell. Detecting it proves the sprite path (not the text fallback);
// the 64×64 source (larger than the ~48px cell target) also exercises the
// resize-to-fit path, so an over-scaled icon can't silently overflow its cell.
const PROBE_ICON_MAGENTA = { r: 0xff, g: 0x2f, b: 0xd0 };

// InventoryUI's panel background after the equipment design-language port
// (COLORS.panelBg = 0x2f3f61, "blue-steel"). Before the port the panel filled
// with dark-navy 0x0d0d1a, so asserting this colour renders in the panel's
// left padding gutter is a genuine before/after discriminator for the palette
// swap: the old panel/cell fills are >70 away in RGB space and the new cellBg
// (0x445c89) is ~54 away, so a match at threshold 30 specifically indicates the
// blue-steel panel background.
const PANEL_BLUE_STEEL = { r: 0x2f, g: 0x3f, b: 0x61 };

function overlaps(a: ScreenBounds, b: ScreenBounds): boolean {
  const left = Math.max(a.x, b.x);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const top = Math.max(a.y, b.y);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > left && bottom > top;
}

function saveDebugShot(buf: Buffer, filename: string): void {
  try {
    const dir = resolve(process.cwd(), 'tmp', 'e2e-screenshots');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, filename), buf);
  } catch {
    // Best-effort debug artefact only.
  }
}

/**
 * Bounds of the merchant-charm cell, located by item id rather than a fixed
 * index: the lab seeds placeholder gear for every slot, so rarity-sorted order
 * no longer puts the charm at cell 0. The charm is the only cell rendering the
 * magenta probe sprite, so the sprite/hover/pin assertions target it directly.
 */
async function charmCellBounds(page: Page): Promise<ScreenBounds | null> {
  const idx = await probe.getInventoryCellIndexForItem(page, MERCHANTS_CHARM_DEF.id);
  return idx === null ? null : probe.getInventoryCellBounds(page, idx);
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

    const cell = await charmCellBounds(page);
    expect(cell, 'charm inventory cell should be rendered').not.toBeNull();
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

  it('renders the panel with the blue-steel equipment design language', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);

    await probe.openInventory(page);
    await page.waitForTimeout(300);
    expect(await probe.isInventoryOpen(page)).toBe(true);

    // Sample the panel background in the gutter just left of column 0. The grid
    // is centered within the panel, so column 0's left edge sits well inside the
    // panel border; the strip immediately left of it, at the grid's vertical
    // level, is pure panel background — no cells, item icons, rarity borders, or
    // corner pixels — which makes "contains blue-steel" a true palette test.
    // Sampling over the cells themselves is NOT a discriminator: item art can
    // contain incidental blue-steel-ish pixels regardless of the panel palette.
    const cell = await probe.getInventoryCellBounds(page, 0);
    expect(cell, 'first inventory cell should be rendered').not.toBeNull();
    if (!cell) return;

    const rect = await getCanvasRect(page);
    const game = await getGameSize(page);
    const sx = rect.width / game.width;
    const sy = rect.height / game.height;
    const topLeft = designToScreen(rect, game, cell.x - 14, cell.y + 4);
    const region = {
      x: Math.round(topLeft.x),
      y: Math.round(topLeft.y),
      w: Math.max(2, Math.round(11 * sx)),
      h: Math.max(2, Math.round((cell.height - 8) * sy)),
    };

    const buf = await page.screenshot({ type: 'png' });
    saveDebugShot(buf, 'inventory-blue-steel.png');
    const png = parsePng(buf);

    expect(
      regionContainsColor(png, region, PANEL_BLUE_STEEL, 30),
      'Expected the inventory panel to render the blue-steel background ' +
        '(COLORS.panelBg = 0x2f3f61) ported from EquipmentUI. If this fails, the ' +
        'panel is still using the old dark-navy palette.',
    ).toBe(true);
  });

  it('shows a tooltip on hover and clears it on hover-out (unpinned)', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openInventory(page);
    await page.waitForTimeout(300);

    const cell = await charmCellBounds(page);
    expect(cell, 'charm inventory cell should be rendered').not.toBeNull();
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

    const cell = await charmCellBounds(page);
    expect(cell, 'charm inventory cell should be rendered').not.toBeNull();
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

  it('renders equipped-item icon art in the paper-doll slot when available', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openEquipment(page);
    await page.waitForTimeout(300);

    expect(await probe.equipCharm(page)).toBe(true);
    await page.waitForTimeout(200);

    const slotBounds = await probe.getEquipmentSlotBounds(page, 'neck');
    expect(slotBounds, 'neck slot bounds should be available in equipment panel').not.toBeNull();
    if (!slotBounds) return;

    const rect = await getCanvasRect(page);
    const game = await getGameSize(page);
    const topLeft = designToScreen(rect, game, slotBounds.x, slotBounds.y);
    const region = {
      x: Math.round(topLeft.x),
      y: Math.round(topLeft.y),
      w: Math.round(slotBounds.width * (rect.width / game.width)),
      h: Math.round(slotBounds.height * (rect.height / game.height)),
    };

    const buf = await page.screenshot({ type: 'png' });
    const png = parsePng(buf);
    expect(
      regionContainsColor(png, region, PROBE_ICON_MAGENTA, 70),
      'Expected equipped neck slot to render the generated icon art, not only text.',
    ).toBe(true);
  });

  it('shows and clears equipment hover tooltips like inventory', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openEquipment(page);
    await page.waitForTimeout(300);

    expect(await probe.equipCharm(page)).toBe(true);
    await page.waitForTimeout(200);

    const slotBounds = await probe.getEquipmentSlotBounds(page, 'neck');
    expect(slotBounds, 'neck slot bounds should be available in equipment panel').not.toBeNull();
    if (!slotBounds) return;

    const rect = await getCanvasRect(page);
    const game = await getGameSize(page);
    const center = boundsCenterScreen(rect, game, slotBounds);

    await page.mouse.move(center.x, center.y);
    await page.waitForTimeout(250);
    expect(await probe.isEquipmentTooltipVisible(page)).toBe(true);

    const away = designToScreen(rect, game, 8, 8);
    await page.mouse.move(away.x, away.y);
    await page.waitForTimeout(250);
    expect(await probe.isEquipmentTooltipVisible(page)).toBe(false);
  });

  it('keeps all equipment slot boxes non-overlapping', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openEquipment(page);
    await page.waitForTimeout(300);

    const boundsBySlot = new Map<string, ScreenBounds>();
    for (const slot of SLOT_REGISTRY) {
      const bounds = await probe.getEquipmentSlotBounds(page, slot.id);
      expect(bounds, `expected bounds for equipment slot "${slot.id}"`).not.toBeNull();
      if (bounds) {
        boundsBySlot.set(slot.id, bounds);
      }
    }

    const entries = [...boundsBySlot.entries()];
    for (let i = 0; i < entries.length; i += 1) {
      const [slotA, boundsA] = entries[i]!;
      for (let j = i + 1; j < entries.length; j += 1) {
        const [slotB, boundsB] = entries[j]!;
        expect(
          overlaps(boundsA, boundsB),
          `equipment slots overlap: ${slotA} intersects ${slotB}`,
        ).toBe(false);
      }
    }
  });

  it('double-clicks an inventory item to equip it onto the paper-doll', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openInventory(page);
    await page.waitForTimeout(300);

    // The lab seeds one of every placeholder gear at startup. Locate the chest
    // piece by id (rarity-sorted order is not fixed) and confirm it starts unworn.
    const chestIdx = await probe.getInventoryCellIndexForItem(page, 'iron-breastplate');
    expect(chestIdx, 'seeded chest gear should have an inventory cell').not.toBeNull();
    if (chestIdx === null) return;
    expect(await probe.getEquippedSlotIds(page)).not.toContain('chest');

    const cell = await probe.getInventoryCellBounds(page, chestIdx);
    expect(cell, 'chest gear cell bounds should be rendered').not.toBeNull();
    if (!cell) return;

    const rect = await getCanvasRect(page);
    const game = await getGameSize(page);
    const center = boundsCenterScreen(rect, game, cell);

    // A double-click (two pointerdowns within DOUBLE_CLICK_MS on the same item)
    // is the dedicated equip gesture; a single click still only pins the tooltip.
    await page.mouse.dblclick(center.x, center.y);
    await page.waitForTimeout(250);

    const equipped = await probe.getEquippedSlotIds(page);
    expect(equipped, 'double-clicking chest gear should fill the chest slot').toContain('chest');
    // The equipped item left the bag, so its old cell no longer resolves to it.
    expect(await probe.getInventoryCellIndexForItem(page, 'iron-breastplate')).toBeNull();
  });

  // --- Integrated equippable-bag column (inside the equipment panel) ---------
  // The driving request: "there's still no way to see equipment inventory while
  // in the paper-doll". The equipment panel now embeds a bag column so the
  // player can browse and equip gear without leaving the paper-doll. These
  // checks lock in that the bag is visible, non-occluding, hover-previews the
  // stat delta, and equips in-place.

  it('shows the integrated bag column inside the equipment panel without occluding the paper-doll', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openEquipmentOnly(page);
    await page.waitForTimeout(300);
    expect(await probe.isEquipmentOpen(page), 'equipment paper-doll should open').toBe(true);

    const bagIds = await probe.getEquipmentBagItemIds(page);
    expect(
      bagIds.length,
      'the integrated bag should list the seeded equippable gear',
    ).toBeGreaterThan(0);

    const panel = await probe.getEquipmentPanelBounds(page);
    const within = (inner: ScreenBounds, outer: ScreenBounds): boolean =>
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width &&
      inner.y + inner.height <= outer.y + outer.height;

    // Collect every paper-doll slot box so we can prove the bag never overlaps
    // one — the exact failure that made the old design unusable (the equipment
    // modal occluded the bag).
    const slotBounds: ScreenBounds[] = [];
    for (const slot of SLOT_REGISTRY) {
      const b = await probe.getEquipmentSlotBounds(page, slot.id);
      if (b) slotBounds.push(b);
    }

    let visibleCells = 0;
    for (let i = 0; i < bagIds.length; i += 1) {
      const cell = await probe.getEquipmentBagCellBounds(page, i);
      if (!cell) continue; // off-screen (scrolled) cells report null by design
      visibleCells += 1;
      expect(within(cell, panel), `bag cell ${i} should sit inside the equipment panel`).toBe(true);
      for (const slot of slotBounds) {
        expect(overlaps(cell, slot), `bag cell ${i} must not overlap a paper-doll slot`).toBe(
          false,
        );
      }
    }
    expect(visibleCells, 'at least one bag cell should be visible in the panel').toBeGreaterThan(0);
  });

  it('previews the equip-delta in the inspector when hovering a bag item', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openEquipmentOnly(page);
    await page.waitForTimeout(250);

    expect(await probe.getEquipmentBagItemIds(page)).toContain('iron-breastplate');

    await probe.previewEquipmentBagItem(page, 'iron-breastplate');
    await page.waitForTimeout(150);
    expect(
      await probe.isEquipmentTooltipVisible(page),
      'hovering a bag item should show its equip-delta preview in the inspector',
    ).toBe(true);

    await probe.previewEquipmentBagItem(page, null);
    await page.waitForTimeout(150);
    expect(
      await probe.isEquipmentTooltipVisible(page),
      'leaving a bag item should clear the equip-delta preview',
    ).toBe(false);
  });

  it('supports pointer-driven equipped and bag tooltips, filtering, equip, and unequip', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openEquipmentOnly(page);
    await page.waitForTimeout(250);

    const rect = await getCanvasRect(page);
    const game = await getGameSize(page);

    // Selecting an empty slot filters the integrated bag to that destination;
    // clicking it again clears the filter before we inspect the full bag.
    const emptyChestSlot = await probe.getEquipmentSlotBounds(page, 'chest');
    expect(emptyChestSlot, 'the empty chest slot should be interactive').not.toBeNull();
    if (!emptyChestSlot) return;
    const emptyChestCenter = boundsCenterScreen(rect, game, emptyChestSlot);
    await page.mouse.click(emptyChestCenter.x, emptyChestCenter.y);
    await page.waitForTimeout(150);
    expect(await probe.getEquipmentSlotFilter(page)).toBe('chest');
    expect(await probe.getInventorySlotFilter(page)).toBe('chest');
    expect(await probe.getEquipmentBagItemIds(page)).toContain('iron-breastplate');

    await page.mouse.click(emptyChestCenter.x, emptyChestCenter.y);
    await page.waitForTimeout(150);
    expect(await probe.getEquipmentSlotFilter(page)).toBeNull();

    // An unequipped bag item uses the inspector as a hover preview and its
    // target marker identifies the paper-doll destination before commitment.
    const bagItems = await probe.getEquipmentBagItemIds(page);
    const bagIndex = bagItems.indexOf('iron-breastplate');
    expect(
      bagIndex,
      'the chest item should be available in the integrated bag',
    ).toBeGreaterThanOrEqual(0);
    const bagCell = await probe.getEquipmentBagCellBounds(page, bagIndex);
    expect(bagCell, 'the chest item should have a visible bag cell').not.toBeNull();
    if (!bagCell) return;
    const bagCenter = boundsCenterScreen(rect, game, bagCell);
    await page.mouse.move(bagCenter.x, bagCenter.y);
    await page.waitForTimeout(150);
    expect(
      await probe.isEquipmentTooltipVisible(page),
      'bag hover should show the item preview',
    ).toBe(true);
    expect(
      await probe.isEquipmentTooltipTopmost(page),
      'bag preview must not render behind the panel',
    ).toBe(true);
    expect(await probe.getEquipmentPreviewTargetSlots(page)).toContain('chest');

    await page.mouse.click(bagCenter.x, bagCenter.y);
    await page.waitForTimeout(150);
    expect(await probe.getEquippedSlotIds(page)).toContain('chest');

    const chestSlot = await probe.getEquipmentSlotBounds(page, 'chest');
    expect(chestSlot, 'the equipped chest slot should remain interactive').not.toBeNull();
    if (!chestSlot) return;
    const chestCenter = boundsCenterScreen(rect, game, chestSlot);
    await page.mouse.move(chestCenter.x, chestCenter.y);
    await page.waitForTimeout(150);
    expect(
      await probe.isEquipmentTooltipVisible(page),
      'equipped-item hover should show its tooltip',
    ).toBe(true);
    expect(await probe.getEquipmentTooltipBounds(page)).not.toBeNull();
    expect(
      await probe.isEquipmentTooltipTopmost(page),
      'equipped tooltip must stay above the paper doll',
    ).toBe(true);

    // The first click selects and visibly filters the matching bag slot; the
    // second click performs the advertised unequip action.
    await page.mouse.click(chestCenter.x, chestCenter.y);
    await page.waitForTimeout(150);
    expect(await probe.getEquipmentSlotFilter(page)).toBe('chest');
    expect(await probe.getInventorySlotFilter(page)).toBe('chest');

    await page.mouse.click(chestCenter.x, chestCenter.y);
    await page.waitForTimeout(150);
    expect(await probe.getEquippedSlotIds(page)).not.toContain('chest');
    expect(await probe.getEquipmentBagItemIds(page)).toContain('iron-breastplate');
  });

  it('equips a gear item directly from the integrated bag column', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openEquipmentOnly(page);
    await page.waitForTimeout(250);

    expect(await probe.getEquippedSlotIds(page)).not.toContain('chest');
    expect(await probe.getEquipmentBagItemIds(page)).toContain('iron-breastplate');

    expect(
      await probe.equipFromEquipmentBag(page, 'iron-breastplate'),
      'equipping from the integrated bag should succeed in the safe-room context',
    ).toBe(true);
    await page.waitForTimeout(200);

    expect(
      await probe.getEquippedSlotIds(page),
      'equipping from the bag should fill the chest slot',
    ).toContain('chest');
    expect(
      await probe.getEquipmentBagItemIds(page),
      'the equipped item should leave the integrated bag',
    ).not.toContain('iron-breastplate');
  });

  it('scrolls the integrated bag column when it overflows its visible rows', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await probe.openEquipmentOnly(page);
    await page.waitForTimeout(250);

    // Force the bag to overflow: 40 equippable cells at 4 columns = 10 rows,
    // far more than the visible rows, so the tail is only reachable by scrolling.
    const total = 40;
    await probe.seedOverflowBag(page, total);
    await page.waitForTimeout(200);

    const maxScroll = await probe.getEquipmentBagMaxScrollRow(page);
    expect(maxScroll, 'a 40-cell bag must overflow its visible rows').toBeGreaterThan(0);
    expect(await probe.getEquipmentBagScrollRow(page), 'the bag starts at the top row').toBe(0);

    // Before scrolling: the first cell is visible, the last cell is off-screen
    // (off-screen cells report null bounds by design).
    expect(
      await probe.getEquipmentBagCellBounds(page, 0),
      'the first cell should be visible before scrolling',
    ).not.toBeNull();
    expect(
      await probe.getEquipmentBagCellBounds(page, total - 1),
      'the last cell should be off-screen before scrolling',
    ).toBeNull();

    // A real wheel event over the bag column scrolls it — the exact affordance
    // that was missing (the integrated bag was previously unscrollable, trapping
    // any gear beyond the visible rows).
    const col = await probe.getEquipmentBagColumnBounds(page);
    expect(col, 'the bag column should report screen bounds').not.toBeNull();
    if (col) {
      const rect = await getCanvasRect(page);
      const game = await getGameSize(page);
      const domCenter = boundsCenterScreen(rect, game, col);
      await page.mouse.move(domCenter.x, domCenter.y);
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(150);
      expect(
        await probe.getEquipmentBagScrollRow(page),
        'a downward wheel over the bag should advance the scroll row',
      ).toBeGreaterThan(0);
    }

    // Programmatic scroll to the bottom reveals the previously-hidden tail cell
    // and hides the head cell — proving the whole overflow is reachable.
    await probe.scrollEquipmentBag(page, maxScroll);
    await page.waitForTimeout(150);
    expect(
      await probe.getEquipmentBagScrollRow(page),
      'scrolling by maxScroll should reach the last row',
    ).toBe(maxScroll);
    expect(
      await probe.getEquipmentBagCellBounds(page, total - 1),
      'the last cell should be visible after scrolling to the bottom',
    ).not.toBeNull();
    expect(
      await probe.getEquipmentBagCellBounds(page, 0),
      'the first cell should scroll off-screen at the bottom',
    ).toBeNull();

    // Scrolling back up returns to the top and re-clamps at row 0.
    await probe.scrollEquipmentBag(page, -(maxScroll + 5));
    await page.waitForTimeout(150);
    expect(
      await probe.getEquipmentBagScrollRow(page),
      'scrolling up past the top should clamp at row 0',
    ).toBe(0);
  });

  it('hides the docked minimap while the equipment panel is open so it cannot overlap the bag', async () => {
    await loadUiProbeLab(page);
    await hideLabChrome(page);
    await page.waitForTimeout(200);

    // With no panel open, the docked radar is visible in the top-right corner.
    const dockedBefore = await probe.getMinimapDockedBounds(page);
    expect(
      dockedBefore,
      'the minimap should be docked/visible before any panel opens',
    ).not.toBeNull();

    await probe.openEquipmentOnly(page);
    await page.waitForTimeout(300);

    // The widened equipment panel reaches the top-right corner, so the docked
    // minimap (HUD_DEPTH..+8) would punch through it. Opening the panel must
    // hide the minimap entirely.
    const dockedAfter = await probe.getMinimapDockedBounds(page);
    expect(
      dockedAfter,
      'the docked minimap must be hidden while the equipment panel is open',
    ).toBeNull();

    // Sanity: the panel really does reach into the minimap corner, so this
    // assertion is meaningful (not a no-op on a narrow panel).
    const panel = await probe.getEquipmentPanelBounds(page);
    expect(panel, 'equipment panel bounds should be available').not.toBeNull();
    if (panel && dockedBefore) {
      expect(
        overlaps(panel, dockedBefore),
        'the panel should geometrically overlap where the minimap was docked (proving the hide is necessary)',
      ).toBe(true);
    }
  });
});

/**
 * Equipment decision gate (UX Designer slice).
 *
 * These are the deterministic checks that back the equipment UX work: the
 * player must be able to see what a swap does *before* committing to it, the
 * spatial model must stay stable while they do, and the text must survive every
 * supported viewport. Everything here drives the real Phaser panel through the
 * probe API and reads real rendered geometry — no mocks, no eyeballing.
 */
describe('equipment decision gate (e2e)', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  async function openDecisionState(viewport: {
    width: number;
    height: number;
  }): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const decisionPage = await context.newPage();
    await loadUiProbeLab(decisionPage);
    await hideLabChrome(decisionPage);
    await seedEquipmentDecisionState(decisionPage);
    return { context, page: decisionPage };
  }

  it('captures the equipment panel for visual review', async () => {
    const { context, page: shot } = await openDecisionState({ width: 1280, height: 800 });
    try {
      const outPath = captureArtifactPath('equipment');
      await captureEquipmentPanel(shot, outPath);
      expect(existsSync(outPath), `capture should be written to ${outPath}`).toBe(true);
    } finally {
      await closeQuietly(context);
    }
  });

  /**
   * Every slot carries a visible identity label.
   *
   * SLOT_REGISTRY has always had a human `label` per slot, but the panel did not
   * render it — so an empty slot was an anonymous grey square and the player had
   * to hover each one to learn what it accepted. The screenshot judge reported
   * this repeatedly as a task-readiness defect; per the repo rule that a
   * recurring review finding should become a deterministic check rather than
   * relying on future model consistency, it is gated here on real rendered text.
   */
  it('renders a visible identity label for every equipment slot', async () => {
    const { context, page: labelPage } = await openDecisionState({ width: 1280, height: 800 });
    try {
      const runs = await probe.getEquipmentTextRuns(labelPage);
      const dollText = runs.filter((run) => run.region === 'doll').map((run) => run.text);
      for (const slot of SLOT_REGISTRY) {
        expect(
          dollText,
          `slot "${slot.id}" must render its "${slot.label}" identity label in the doll region`,
        ).toContain(slot.label);
      }
    } finally {
      await closeQuietly(context);
    }
  });

  /**
   * Stat labels are not shouted.
   *
   * Long all-caps runs strip the word-shape cues readers scan by, and the
   * screenshot judge scores them as legibility strain. Acronyms (HP, XP) are
   * legitimately short, so only multi-character all-caps words are rejected.
   */
  it('avoids long all-capital label runs in the stats column', async () => {
    const { context, page: capsPage } = await openDecisionState({ width: 1280, height: 800 });
    try {
      const runs = await probe.getEquipmentTextRuns(capsPage);
      for (const run of runs.filter((entry) => entry.region === 'stats')) {
        const shouted = run.text.match(/\b[A-Z]{4,}\b/g) ?? [];
        expect(shouted, `stats text "${run.text}" should not use long all-caps runs`).toEqual([]);
      }
    } finally {
      await closeQuietly(context);
    }
  });

  /**
   * Hover/tooltip captures.
   *
   * A still of the resting panel cannot show what hovering an equipped slot, an
   * empty slot, or a bag item reveals, and the judge correctly lists interaction
   * feedback under `notObservable`. Capturing the hovered states as their own
   * artifacts is what makes those interaction models reviewable at all.
   */
  it('captures equipped, empty, and bag hover states for visual review', async () => {
    const { context, page: hoverPage } = await openDecisionState({ width: 1280, height: 800 });
    try {
      const equippedSlot = 'head';
      const emptySlot = 'feet';

      expect(await probe.previewEquipmentSlot(hoverPage, equippedSlot)).toBe(true);
      expect(await probe.isEquipmentTooltipVisible(hoverPage)).toBe(true);
      await captureEquipmentPanel(hoverPage, captureArtifactPath('equipment-tooltip-equipped'));

      expect(await probe.previewEquipmentSlot(hoverPage, emptySlot)).toBe(true);
      expect(await probe.isEquipmentTooltipVisible(hoverPage)).toBe(true);
      await captureEquipmentPanel(hoverPage, captureArtifactPath('equipment-tooltip-empty'));

      // Slot filtering: selecting a slot narrows the bag to what fits it.
      expect(await probe.selectEquipmentSlot(hoverPage, emptySlot)).toBe(true);
      await captureEquipmentPanel(hoverPage, captureArtifactPath('equipment-slot-filtered'));
      expect(await probe.getEquipmentSlotFilter(hoverPage)).toBe(emptySlot);

      await probe.selectEquipmentSlot(hoverPage, null);
      const bagIds = await probe.getEquipmentBagItemIds(hoverPage);
      expect(bagIds.length, 'the bag should hold reviewable items').toBeGreaterThan(0);
      await probe.previewEquipmentBagItem(hoverPage, bagIds[0]!);
      await captureEquipmentPanel(hoverPage, captureArtifactPath('equipment-tooltip-bag'));
      expect(await probe.isEquipmentTooltipVisible(hoverPage)).toBe(true);

      for (const name of [
        'equipment-tooltip-equipped',
        'equipment-tooltip-empty',
        'equipment-slot-filtered',
        'equipment-tooltip-bag',
      ]) {
        expect(existsSync(captureArtifactPath(name)), `${name} capture should exist`).toBe(true);
      }
    } finally {
      await closeQuietly(context);
    }
  });

  it('keeps rendered text contained, collision-free, and readable at every supported viewport', async () => {
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 960, height: 600 },
    ]) {
      const { context, page: decisionPage } = await openDecisionState(viewport);
      try {
        const [panel, header, doll, bag, stats, inspector, canvas, runs, raster] =
          await Promise.all([
            probe.getEquipmentPanelBounds(decisionPage),
            probe.getEquipmentHeaderBounds(decisionPage),
            probe.getEquipmentDollBounds(decisionPage),
            probe.getEquipmentBagColumnBounds(decisionPage),
            probe.getEquipmentStatsBounds(decisionPage),
            probe.getEquipmentInspectorBounds(decisionPage),
            getCanvasRect(decisionPage),
            probe.getEquipmentTextRuns(decisionPage),
            probe.getEquipmentTextRasterMetadata(decisionPage),
          ]);
        const regions = { header, doll, bag, stats, inspector };
        expect(runs.length, 'the live panel should expose rendered text runs').toBeGreaterThan(0);
        expect(raster, 'the live panel should expose raster metadata').not.toBeNull();
        expect(raster?.intendedFontIdentity).toBe('Press Start 2P');
        expect(raster?.loadedFontIdentity).toBe('Press Start 2P');
        expect(raster?.fontLoadState).toBe('loaded');
        expect(raster?.fontSourceUrl).toMatch(/\/fonts\/PressStart2P-Regular\.ttf$/);
        expect(raster?.textResolution).toBeGreaterThanOrEqual(6);
        expect(
          Number.isInteger(raster?.containerScale),
          'panel scale must stay pixel-aligned',
        ).toBe(true);
        expect(raster?.roundPixels).toBe(true);
        expect(raster?.fractionalTextBounds).toBe(0);

        for (const run of runs) {
          const region = regions[run.region];
          expect(region, `${run.region} region should exist`).not.toBeNull();
          if (!region) continue;
          expect(
            containsWithin(region, run.bounds, 1),
            `${run.region} text "${run.text}" must remain inside its region at ${viewport.width}×${viewport.height}`,
          ).toBe(true);
          expect(
            physicalGlyphPx(run.renderedFontSize, canvas),
            `${run.region} text "${run.text}" must remain readable at ${viewport.width}×${viewport.height}`,
          ).toBeGreaterThanOrEqual(MIN_READABLE_GLYPH_PX);
        }

        for (let index = 0; index < runs.length; index += 1) {
          for (let other = index + 1; other < runs.length; other += 1) {
            const current = runs[index]!;
            const next = runs[other]!;
            if (current.region !== next.region) continue;
            expect(
              overlapArea(current.bounds, next.bounds),
              `${current.region} text "${current.text}" must not collide with "${next.text}" at ${viewport.width}×${viewport.height}`,
            ).toBe(0);
          }
        }
        expect(containsWithin(panel, header!, 1)).toBe(true);
      } finally {
        await closeQuietly(context);
      }
    }
  });

  it('marks the preview destination and reverses an equip with unequip', async () => {
    const { context, page: decisionPage } = await openDecisionState({
      width: 1280,
      height: 800,
    });
    try {
      await probe.previewEquipmentBagItem(decisionPage, 'iron-breastplate');
      await decisionPage.waitForTimeout(150);
      expect(await probe.getEquipmentPreviewTargetSlots(decisionPage)).toContain('chest');
      expect(await probe.getEquipmentTargetMarkerBounds(decisionPage, 'chest')).not.toBeNull();

      const beforeCharisma = await probe.getCharisma(decisionPage);
      expect(await probe.equipFromEquipmentBag(decisionPage, 'iron-breastplate')).toBe(true);
      await decisionPage.waitForTimeout(150);
      expect(await probe.getEquippedSlotIds(decisionPage)).toContain('chest');

      await probe.unequipEquipmentSlot(decisionPage, 'chest');
      await decisionPage.waitForTimeout(150);
      expect(await probe.getEquippedSlotIds(decisionPage)).not.toContain('chest');
      expect(await probe.getEquipmentBagItemIds(decisionPage)).toContain('iron-breastplate');
      expect(await probe.getCharisma(decisionPage)).toBe(beforeCharisma);
    } finally {
      await closeQuietly(context);
    }
  });

  it('retains an active bag comparison when filtering rerenders the panel', async () => {
    const { context, page: decisionPage } = await openDecisionState({
      width: 1280,
      height: 800,
    });
    try {
      await probe.previewEquipmentBagItem(decisionPage, 'iron-breastplate');
      await decisionPage.waitForTimeout(150);
      expect(await probe.getEquipmentPreviewTargetSlots(decisionPage)).toContain('chest');
      expect(await probe.isEquipmentTooltipVisible(decisionPage)).toBe(true);

      expect(await probe.selectEquipmentSlot(decisionPage, 'chest')).toBe(true);
      await decisionPage.waitForTimeout(150);

      expect(await probe.getEquipmentPreviewTargetSlots(decisionPage)).toContain('chest');
      expect(await probe.getEquipmentTargetMarkerBounds(decisionPage, 'chest')).not.toBeNull();
      expect(await probe.isEquipmentTooltipVisible(decisionPage)).toBe(true);
    } finally {
      await closeQuietly(context);
    }
  });
});
