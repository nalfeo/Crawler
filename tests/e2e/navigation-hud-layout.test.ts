import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import { closeQuietly } from './helpers/ui-probe.js';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface NavigationBounds {
  radar: Bounds | null;
  questTracker: Bounds | null;
  familyPanel: Bounds | null;
  arrows: Bounds[];
  mapOverlay: Bounds | null;
  mapClose: Bounds | null;
}

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=ux-snapshot-lab`;
const CRITICAL_HUD: readonly Bounds[] = [
  { x: 410, y: 0, width: 460, height: 118 },
  { x: 0, y: 496, width: 390, height: 224 },
  { x: 330, y: 598, width: 620, height: 122 },
];

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function expectInsideDesignViewport(bounds: Bounds): void {
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1280);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(720);
}

async function loadStressState(page: Page, floor: number): Promise<NavigationBounds> {
  await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __navigationHudProbe?: { ready(): boolean };
        }
      ).__navigationHudProbe?.ready() === true,
    { timeout: 30_000 },
  );
  await page.evaluate((targetFloor) => {
    (
      window as unknown as {
        __navigationHudProbe: {
          setStressState(floor: number): void;
        };
      }
    ).__navigationHudProbe.setStressState(targetFloor);
  }, floor);
  await page.waitForTimeout(500);
  return page.evaluate(() =>
    (
      window as unknown as {
        __navigationHudProbe: { getBounds(): NavigationBounds };
      }
    ).__navigationHudProbe.getBounds(),
  );
}

describe('navigation HUD deterministic layout', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 90_000);

  afterAll(async () => {
    await closeQuietly(browser);
  }, 90_000);

  for (const viewport of [
    { name: 'desktop', width: 1280, height: 720 },
    { name: 'mobile landscape', width: 844, height: 390 },
  ]) {
    it(`keeps stressed Floor 1 navigation inside and mutually clear at ${viewport.name}`, async () => {
      const page = await browser.newPage({ viewport });
      const bounds = await loadStressState(page, 1);
      const regions = [bounds.radar, bounds.questTracker, ...bounds.arrows].filter(
        (box): box is Bounds => box !== null,
      );

      expect(bounds.radar).not.toBeNull();
      expect(bounds.questTracker).not.toBeNull();
      expect(bounds.arrows.length).toBeGreaterThanOrEqual(2);
      for (const region of regions) expectInsideDesignViewport(region);
      for (let i = 0; i < regions.length; i += 1) {
        for (let j = i + 1; j < regions.length; j += 1) {
          expect(overlaps(regions[i]!, regions[j]!)).toBe(false);
        }
      }
      for (const arrow of bounds.arrows) {
        for (const critical of CRITICAL_HUD) {
          expect(overlaps(arrow, critical)).toBe(false);
        }
      }
      await page.close();
    });

    it(`suppresses docked navigation under the fullscreen map at ${viewport.name}`, async () => {
      const page = await browser.newPage({ viewport });
      await loadStressState(page, 1);
      await page.keyboard.press('m');
      await page.waitForTimeout(400);
      const bounds = await page.evaluate(() =>
        (
          window as unknown as {
            __navigationHudProbe: { getBounds(): NavigationBounds };
          }
        ).__navigationHudProbe.getBounds(),
      );

      expect(bounds.mapOverlay).not.toBeNull();
      expect(bounds.mapClose).not.toBeNull();
      expect(bounds.radar).toBeNull();
      expect(bounds.questTracker).toBeNull();
      expect(bounds.familyPanel).toBeNull();
      expect(bounds.arrows).toEqual([]);
      expectInsideDesignViewport(bounds.mapOverlay!);
      expectInsideDesignViewport(bounds.mapClose!);
      await page.close();
    });
  }

  it('relocates the mobile Floor 2 tracker to the upper-left navigation lane', async () => {
    const page = await browser.newPage({ viewport: { width: 844, height: 390 } });
    const bounds = await loadStressState(page, 2);

    expect(bounds.questTracker).not.toBeNull();
    expect(bounds.questTracker!.x).toBe(16);
    expect(bounds.questTracker!.y).toBe(78);
    expect(bounds.radar).not.toBeNull();
    expect(overlaps(bounds.questTracker!, bounds.radar!)).toBe(false);
    await page.close();
  }, 90_000);
});
