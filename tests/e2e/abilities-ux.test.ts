import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type {
  AbilitiesProbeApi,
  AbilitiesProbeSnapshot,
} from '../../src/labs/abilities-lab/index.js';
import type { ScreenBounds } from '../../src/engine/ui-scale.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL, GAME_H, GAME_W } from './e2e-constants.js';

declare global {
  interface Window {
    __abilitiesProbe?: AbilitiesProbeApi;
  }
}

const LAB_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=abilities-lab&review=1`;
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 960, height: 540 },
] as const;

function contains(outer: ScreenBounds, inner: ScreenBounds): boolean {
  const epsilon = 0.01;
  return (
    inner.x >= outer.x - epsilon &&
    inner.y >= outer.y - epsilon &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon
  );
}

function overlaps(a: ScreenBounds, b: ScreenBounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function loadAbilitiesLab(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(LAB_URL, { waitUntil: 'commit', timeout: 45_000 });
    try {
      await page.waitForFunction(() => Boolean(window.__abilitiesProbe?.ready()), undefined, {
        timeout: 30_000,
        polling: 200,
      });
      await page.waitForTimeout(500);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

async function openLoadout(page: Page): Promise<AbilitiesProbeSnapshot> {
  await page.evaluate(() => window.__abilitiesProbe!.openLoadout());
  await page.waitForFunction(
    () => window.__abilitiesProbe?.getSnapshot().open === true,
    undefined,
    {
      timeout: 10_000,
    },
  );
  return page.evaluate(() => window.__abilitiesProbe!.getSnapshot());
}

describe('abilities hotbar and loadout UX', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  for (const viewport of VIEWPORTS) {
    it(`contains every surface without overlap at ${viewport.width}x${viewport.height}`, async () => {
      const page = await browser.newPage({ viewport });
      await loadAbilitiesLab(page);

      const hotbarSnapshot = await page.evaluate(() => window.__abilitiesProbe!.getSnapshot());
      expect(hotbarSnapshot.hotbar).not.toBeNull();
      const hotbar = hotbarSnapshot.hotbar!;
      const gameBounds = { x: 0, y: 0, width: GAME_W, height: GAME_H };
      expect(contains(gameBounds, hotbar), 'hotbar must remain inside the game viewport').toBe(
        true,
      );
      expect(hotbarSnapshot.slots).toHaveLength(10);
      for (const [index, slot] of hotbarSnapshot.slots.entries()) {
        expect(contains(hotbar, slot), `slot ${index} must remain inside the hotbar`).toBe(true);
        for (const later of hotbarSnapshot.slots.slice(index + 1)) {
          expect(overlaps(slot, later), `slot ${index} must not overlap another slot`).toBe(false);
        }
      }

      const loadout = await openLoadout(page);
      expect(loadout.panel).not.toBeNull();
      expect(loadout.listViewport).not.toBeNull();
      expect(loadout.footer).not.toBeNull();
      expect(contains(gameBounds, loadout.panel!), 'loadout panel must remain on-screen').toBe(
        true,
      );
      expect(contains(loadout.panel!, loadout.listViewport!), 'list must remain inside panel').toBe(
        true,
      );
      expect(contains(loadout.panel!, loadout.footer!), 'footer must remain inside panel').toBe(
        true,
      );
      expect(overlaps(loadout.listViewport!, loadout.footer!), 'list must not overlap footer').toBe(
        false,
      );
      for (const [index, row] of loadout.visibleRows.entries()) {
        expect(contains(loadout.listViewport!, row), `row ${index} must remain inside list`).toBe(
          true,
        );
        for (const later of loadout.visibleRows.slice(index + 1)) {
          expect(overlaps(row, later), `row ${index} must not overlap another row`).toBe(false);
        }
      }

      await page.close();
    });
  }

  it('keeps the loadout open while removing and re-equipping the selected ability', async () => {
    const context = await browser.newContext({ viewport: VIEWPORTS[0], deviceScaleFactor: 2 });
    const page = await context.newPage();
    await loadAbilitiesLab(page);
    const opened = await openLoadout(page);
    const secondRow = opened.visibleRows[1]!;
    const secondAbilityId = opened.visibleAbilityIds[1]!;
    await page.mouse.click(secondRow.x + 8, secondRow.y + 8);
    await page.waitForFunction(
      (abilityId) => window.__abilitiesProbe?.getSnapshot().selectedAbilityId === abilityId,
      secondAbilityId,
    );
    await page.mouse.move(
      opened.listViewport!.x + opened.listViewport!.width / 2,
      opened.listViewport!.y + opened.listViewport!.height / 2,
    );
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(
      (firstId) => window.__abilitiesProbe?.getSnapshot().visibleAbilityIds[0] !== firstId,
      opened.visibleAbilityIds[0],
    );
    const before = await page.evaluate(() => window.__abilitiesProbe!.getSnapshot());
    const selectedId = before.selectedAbilityId;

    if (!selectedId) {
      throw new Error('abilities loadout must expose a selected ability');
    }
    expect(before.equippedAbilityIds).toContain(selectedId);
    await page.waitForTimeout(250);
    expect((await page.evaluate(() => window.__abilitiesProbe!.getSnapshot())).frameCount).toBe(
      before.frameCount,
    );

    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (abilityId) => {
        const snapshot = window.__abilitiesProbe?.getSnapshot();
        return snapshot?.open === true && !snapshot.equippedAbilityIds.includes(abilityId);
      },
      selectedId,
      { timeout: 5_000 },
    );

    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (abilityId) => {
        const snapshot = window.__abilitiesProbe?.getSnapshot();
        return snapshot?.open === true && snapshot.equippedAbilityIds.includes(abilityId);
      },
      selectedId,
      { timeout: 5_000 },
    );

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    const scrolled = await page.evaluate(() => window.__abilitiesProbe!.getSnapshot());
    await page.keyboard.press('b');
    await page.waitForFunction(() => window.__abilitiesProbe?.getSnapshot().open === false);
    await page.waitForTimeout(100);
    expect((await page.evaluate(() => window.__abilitiesProbe!.getSnapshot())).open).toBe(false);
    const reopened = await openLoadout(page);

    expect(reopened.selectedAbilityId).toBe(scrolled.selectedAbilityId);
    expect(reopened.visibleAbilityIds).toContain(reopened.selectedAbilityId);

    await context.close();
  });
});
