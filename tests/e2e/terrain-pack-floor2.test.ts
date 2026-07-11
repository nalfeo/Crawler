/**
 * Floor 2 terrain-pack atlas render guard (real MainGameScene).
 *
 * Floor 2 uses a terrain pack (`terrainPackId` from its manifest) whose tiles
 * are stamped from atlas frames — a different render path from the Floor 1
 * generated single-image bypass. This gate proves — in the REAL booted scene —
 * that the pack-backed atlas path actually runs at floor-build time:
 *
 *   packWallCount > 0    walls stamped from the pack atlas (not generated PNG)
 *   packFloorCount > 0   floor tiles stamped from the pack atlas
 *   total tile count > 0 the bake ran and produced tiles
 *
 * The `packWallCount > 0` assertion is the key rule-#15 gate: it proves the
 * atlas-frame pack path is used for walls rather than the `generatedCount`
 * single-image bypass that dominates Floor 1. We also assert that `generatedCount`
 * is strictly less than `packWallCount` — not zero by assumption, but provably
 * NOT the dominant provenance for walls — keeping the guard robust to mixed
 * floors without over-fitting exact counts.
 *
 * Why e2e (not a lab-only claim): reading the source or a unit test proves the
 * branch exists in isolation; ONLY the real booted MainGameScene (preloading
 * assets via BootScene then calling `drawFloorTerrain()` in `create()`) proves
 * the pack assets are loaded AND the routing code actually chose the pack path
 * (AGENTS.md rule #10/#15: lab-only validation is insufficient; observe in a
 * real artifact). The `main-scene-probe-lab` with `?floor=floor2` boots via the
 * exact shipped bootstrap path (`createFloorGameConfig` + `createFloorMainSceneOptions`),
 * so `getTerrainRenderSummary()` observes the actual engine render path.
 *
 * Determinism: fixed `worldSeed` (the lab's PROBE_SEED = 4242) shared with all
 * probe-lab e2e. Terrain is baked once synchronously during scene `create()`, so
 * the counts are stable the moment the probe reports `ready()`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('Floor 2 terrain-pack atlas render guard', () => {
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

  it('stamps pack-atlas wall and floor tiles in the real booted Floor 2 scene', async () => {
    // Boot with ?floor=floor2 — uses `createFloorGameConfig` + `createFloorMainSceneOptions`
    // with floorId='floor2'. BootScene preloads the pack atlas, MainGameScene bakes
    // the terrain in `drawFloorTerrain()` before the loadout modal opens.
    await loadMainSceneProbeLab(page, { floor: 'floor2' });

    // Short poll for headroom: the terrain bake is synchronous in create(), so
    // the counts should be settled immediately after ready(), but we give a few
    // frames of margin against any edge-case boot ordering.
    let summary = await mainSceneProbe.getTerrainRenderSummary(page);
    const deadline = Date.now() + 5_000;
    while (
      summary.packWallCount +
        summary.packFloorCount +
        summary.packCorridorCount +
        summary.generatedCount +
        summary.spriteCount +
        summary.colorCount ===
        0 &&
      Date.now() < deadline
    ) {
      await page.waitForTimeout(100);
      summary = await mainSceneProbe.getTerrainRenderSummary(page);
    }

    const legacyTotal = summary.generatedCount + summary.spriteCount + summary.colorCount;
    const packTotal = summary.packWallCount + summary.packFloorCount + summary.packCorridorCount;
    const total = legacyTotal + packTotal;

    // Precondition: the bake ran and produced at least one tile of any provenance.
    expect(
      total,
      `terrain bake should produce at least one tile (total=0 means bake did not run); ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    // Core gate A: Floor 2 walls use the terrain-pack atlas-frame path.
    // A floor with no pack (or a broken pack lookup) would report packWallCount === 0.
    expect(
      summary.packWallCount,
      `Floor 2 should stamp wall tiles via the pack atlas-frame path (packWallCount=0 ` +
        `means the pack path did not run for walls); summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    // Core gate B: Floor 2 floor tiles also use the pack path.
    expect(
      summary.packFloorCount,
      `Floor 2 should stamp floor tiles via the pack atlas-frame path (packFloorCount=0 ` +
        `means the pack path did not run for floors); summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    // Key provenance gate: pack walls are the dominant wall provenance, not the
    // generated single-image bypass. We do NOT assert generatedCount === 0
    // (mixed floors are possible), but we DO assert that packWallCount strictly
    // exceeds generatedCount — proving walls use the atlas-frame path, not the
    // pre-pack bypass that dominates Floor 1.
    expect(
      summary.packWallCount,
      `packWallCount should exceed generatedCount on Floor 2 — walls use the atlas ` +
        `path, not the generated single-image bypass; summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(summary.generatedCount);
  });

  it('has no missing configured pack door textures when renderable doors exist', async () => {
    await loadMainSceneProbeLab(page, { floor: 'floor2' });

    // Doors are drawn per-frame in `updateDoorOverlay()`, so poll a few frames.
    let doorSummary = await mainSceneProbe.getDoorRenderSummary(page);
    const deadline = Date.now() + 5_000;
    while (doorSummary.packDoorCount === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
      doorSummary = await mainSceneProbe.getDoorRenderSummary(page);
    }

    expect(
      doorSummary.packDoorCount,
      `Floor 2 should render at least one door via the terrain-pack path; ` +
        `doorSummary=${JSON.stringify(doorSummary)}`,
    ).toBeGreaterThan(0);
    expect(
      doorSummary.missingPackDoorTextureCount,
      `all pack doors should have their configured texture loaded; ` +
        `doorSummary=${JSON.stringify(doorSummary)}`,
    ).toBe(0);
  });
});
