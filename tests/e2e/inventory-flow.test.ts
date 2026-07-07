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
