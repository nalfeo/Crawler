import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import { boundsCenterScreen, closeQuietly } from './helpers/ui-probe.js';

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=ai-runner&floor4Shop=1`;
const SEED = '404';
const SHOP_ROWS_PER_PAGE = 4;

interface Snapshot {
  readonly manualControl: boolean;
  readonly shopOpen: boolean;
  readonly equipmentOpen: boolean;
  readonly equipmentButtonBounds: { x: number; y: number; width: number; height: number } | null;
  readonly greenRoomPurchases: number;
  readonly spentOnGreenRoom: number;
  readonly activeWeaponId: string | null;
  readonly equippedMainHand: string | number | null;
  readonly equipmentBagItemIds: readonly string[];
  readonly equipmentBagCellBounds: ReadonlyArray<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  readonly offers: readonly {
    itemId: string;
    purchasedItemId: string | null;
    recommendation: string | null;
  }[];
  readonly lastGreenRoomPurchaseItem: string | null;
  readonly sawAct2: boolean;
}

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const debug = window.__aiRunnerDebug?.();
    const visit = debug?.floor4Arena;
    const world = debug as
      | (typeof debug & {
          greenRoomOffers?: {
            itemId: string;
            purchasedItemId: string | null;
            recommendation: string | null;
          }[];
        })
      | undefined;
    return {
      manualControl: debug?.manualControl ?? false,
      shopOpen: debug?.shopOpen ?? false,
      equipmentOpen: debug?.equipmentOpen ?? false,
      equipmentButtonBounds: debug?.equipmentButtonBounds ?? null,
      greenRoomPurchases: debug?.greenRoomPurchases ?? 0,
      spentOnGreenRoom: debug?.spentOnGreenRoom ?? 0,
      activeWeaponId: debug?.activeWeaponId ?? null,
      equippedMainHand: debug?.equippedMainHand ?? null,
      equipmentBagItemIds: debug?.equipmentBagItemIds ?? [],
      equipmentBagCellBounds: debug?.equipmentBagCellBounds ?? [],
      offers: world?.greenRoomOffers ?? [],
      lastGreenRoomPurchaseItem: world?.lastGreenRoomPurchaseItem ?? null,
      sawAct2:
        visit?.timeline.some((entry) => entry.phase.kind === 'WAVES' && entry.phase.act === 2) ??
        false,
    };
  });
}

async function gameCanvasMetrics(page: Page) {
  const canvas = page.locator('canvas').first();
  const rect = await canvas.boundingBox();
  expect(rect).not.toBeNull();
  const game = await canvas.evaluate((element) => {
    const canvasElement = element as HTMLCanvasElement;
    return {
      width: canvasElement.width,
      height: canvasElement.height,
    };
  });
  return { rect: rect!, game };
}

describe('Floor 4 ordinary MainGameScene Green Room purchase path', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForSelector('#ai-playback-dock', { timeout: 45_000 });
    await page.evaluate(() => {
      const details = document.getElementById('ai-run-setup');
      if (details instanceof HTMLDetailsElement) details.open = true;
    });
    await page.selectOption('#ai-run-target-select', 'floor:floor4');
    await page.fill('#ai-seed-input', SEED);
    await page.click('#ai-run-apply');
    await page.click('#ai-speed-16');
    await page.click('#ai-toggle-run');
  }, 60_000);

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('buys and equips one explained upgrade through canvas controls, then reaches Act 2', async () => {
    await expect
      .poll(() => snapshot(page).then((value) => value.shopOpen), { timeout: 120_000 })
      .toBe(true);
    const opened = await snapshot(page);
    await page.click('#ai-manual-toggle');
    await expect
      .poll(() => snapshot(page).then((value) => value.manualControl), { timeout: 15_000 })
      .toBe(true);
    const chosenIndex = opened.offers.findIndex((offer) => offer.recommendation === 'upgrade');
    expect(
      chosenIndex,
      'ordinary Green Room stock must expose a genuine upgrade',
    ).toBeGreaterThanOrEqual(0);
    const chosen = opened.offers[chosenIndex]!;
    expect(chosen.purchasedItemId).not.toBeNull();

    for (
      let pageIndex = 0;
      pageIndex < Math.floor(chosenIndex / SHOP_ROWS_PER_PAGE);
      pageIndex += 1
    ) {
      await page.keyboard.press('PageDown');
    }
    for (let row = 0; row < chosenIndex % SHOP_ROWS_PER_PAGE; row += 1) {
      await page.keyboard.press('ArrowDown');
    }
    await page.keyboard.press('Enter');
    await expect
      .poll(() => snapshot(page).then((value) => value.greenRoomPurchases), { timeout: 15_000 })
      .toBe(1);
    const bought = await snapshot(page);
    expect(bought.spentOnGreenRoom).toBeGreaterThan(0);
    expect(bought.lastGreenRoomPurchaseItem).toBe(chosen.itemId);

    await page.keyboard.press('Escape');
    await expect
      .poll(() => snapshot(page).then((value) => value.shopOpen), { timeout: 15_000 })
      .toBe(false);
    const gearButton = (await snapshot(page)).equipmentButtonBounds;
    expect(
      gearButton,
      'the visible Gear button must be available in the ordinary scene',
    ).not.toBeNull();
    const beforeGear = await gameCanvasMetrics(page);
    const gearButtonCenter = boundsCenterScreen(beforeGear.rect, beforeGear.game, gearButton!);
    await page.mouse.click(gearButtonCenter.x, gearButtonCenter.y);
    await expect
      .poll(() => snapshot(page).then((value) => value.equipmentOpen), { timeout: 15_000 })
      .toBe(true);
    await expect
      .poll(
        () =>
          snapshot(page).then((value) =>
            value.equipmentBagItemIds.includes(chosen.purchasedItemId!),
          ),
        {
          timeout: 15_000,
        },
      )
      .toBe(true);
    const gear = await snapshot(page);
    const bagIndex = gear.equipmentBagItemIds.indexOf(chosen.purchasedItemId!);
    const cell = gear.equipmentBagCellBounds[bagIndex];
    expect(cell, 'purchased weapon must have a visible integrated-bag cell').not.toBeNull();
    const beforeBagClick = await gameCanvasMetrics(page);
    const bagCellCenter = boundsCenterScreen(beforeBagClick.rect, beforeBagClick.game, cell!);
    await page.mouse.click(bagCellCenter.x, bagCellCenter.y);
    await expect
      .poll(() => snapshot(page).then((value) => value.activeWeaponId), { timeout: 15_000 })
      .toBe(chosen.itemId);

    await page.keyboard.press('Escape');
    await page.click('#ai-manual-toggle');
    await expect
      .poll(() => snapshot(page).then((value) => value.manualControl), { timeout: 15_000 })
      .toBe(false);
    await expect
      .poll(() => snapshot(page).then((value) => value.sawAct2), { timeout: 45_000 })
      .toBe(true);
  }, 210_000);
});
