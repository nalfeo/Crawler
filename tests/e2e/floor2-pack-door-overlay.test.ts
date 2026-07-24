/**
 * Floor 2 terrain-pack door overlay guard (real MainGameScene).
 *
 * The `industrial-cave` terrain pack ships four door textures
 * (open/closed × horizontal/vertical). `BootScene` preloads them via
 * `preloadTerrainPacks` and `updateDoorOverlay` resolves pack variants before
 * falling back to Kenney/generated art.
 *
 * Cave-system biome note: the cave_system generator stamps ALL room-connector
 * doors as DOOR_OPEN (passable) so the connectivity invariant holds; locked
 * boss-den doors are adjacent pairs that cancel each other's wall-flank check.
 * Therefore `renderableClosedCount` is 0 on a freshly-booted Floor 2 —
 * the meaningful sentinel is `openPackCount > 0` (at least one open door used
 * the pack texture instead of Kenney/color fallback).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('Floor 2 terrain-pack door overlay guard', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('renders floor2 doors from industrial-cave doorSet textures in MainGameScene', async () => {
    await loadMainSceneProbeLab(page, { floor: 'floor2' });

    // Cave-system biome: all room-connector doors are DOOR_OPEN from map gen,
    // so poll until at least one open pack door appears (they should be present
    // from the first updateDoorOverlay pass once pack textures are loaded).
    let summary = await mainSceneProbe.getDoorRenderSummary(page);
    const deadline = Date.now() + 5_000;
    while (summary.openPackCount === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
      summary = await mainSceneProbe.getDoorRenderSummary(page);
    }

    // Precondition: the booted Floor 2 map has at least one wall-flanked open
    // door that used the pack texture. A 0 here means pack textures were not
    // loaded (BootScene missing preloadTerrainPacks) or no eligible doors exist.
    expect(
      summary.openPackCount,
      `booted Floor 2 should have at least one open wall-flanked door using pack art; summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    // Core guard: no Kenney/color fallback for open doors — every open
    // wall-flanked door should use the industrial-cave doorSet texture.
    expect(
      summary.openKenneyCount + summary.openColorCount,
      `no open door should fall back to Kenney/color when pack textures are loaded; summary=${JSON.stringify(summary)}`,
    ).toBe(0);

    // Closed doors: the cave_system biome has 0 wall-flanked closed doors at
    // boot, so renderableClosedCount === 0. Verify no closed fallback art either.
    expect(
      summary.closedGeneratedCount + summary.closedKenneyCount + summary.closedColorCount,
      `no closed door should use non-pack art on a pack-backed floor; summary=${JSON.stringify(summary)}`,
    ).toBe(0);
    // Any closed doors that do exist should all use pack art.
    expect(summary.closedPackCount).toBe(summary.renderableClosedCount);
  });
});
