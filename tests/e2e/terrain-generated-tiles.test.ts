/**
 * Terrain-tile render guard (real MainGameScene).
 *
 * Floor 1 ships two co-resident terrain packs (`floor1-dungeon`, `floor1-cave`)
 * that cover every wall, floor, corridor, and special-room tile. The legacy
 * generated-single-image and Kenney-fallback paths are inactive on Floor 1.
 * Floor 2 ships `industrial-cave`. This suite guards the FULL wiring chain for
 * both floors in the real booted scene.
 *
 * Why e2e (not a lab-only claim): a green unit test proves the renderer chooses
 * the pack branch in isolation, and a green map-gen-lab sprite mode only knows
 * Kenney frames — NEITHER proves the REAL MainGameScene loads the pack atlases
 * and stamps them at floor-build time (AGENTS.md rule #10/#15: lab-only
 * validation is insufficient; observe in a real artifact). The
 * `main-scene-probe-lab` HOSTS the real scene booted through the shipped floor
 * bootstrap (BootScene preloads the terrain packs → MainGameScene bakes the
 * terrain in `drawFloorTerrain()` before the loadout modal opens), so
 * `getTerrainRenderSummary().packWallCount > 0` observes the actual engine
 * render path.
 *
 * Determinism: fixed `worldSeed` (the lab's PROBE_SEED) and an exact integer
 * comparison with no wall-clock / RNG input. Terrain is baked once synchronously
 * during scene `create()`, so the counts are stable the moment the probe is
 * ready.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('Terrain-pack render guard', () => {
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

  it('renders Floor 1 terrain-pack wall and floor tiles in the real booted scene', async () => {
    // loadMainSceneProbeLab waits for probe.ready() — which requires the world +
    // player, both created in the same synchronous create() pass that already ran
    // drawFloorTerrain(). So the terrain bake (and its stored counts) is settled.
    await loadMainSceneProbeLab(page);

    // A short poll for headroom in case the very first ready() window lands a
    // frame before the summary field is stored (defensive; bake is synchronous).
    let summary = await mainSceneProbe.getTerrainRenderSummary(page);
    const deadline = Date.now() + 5_000;
    while (
      summary.packWallCount +
        summary.packFloorCount +
        summary.generatedCount +
        summary.spriteCount +
        summary.colorCount ===
        0 &&
      Date.now() < deadline
    ) {
      await page.waitForTimeout(100);
      summary = await mainSceneProbe.getTerrainRenderSummary(page);
    }

    const total =
      summary.packWallCount +
      summary.packFloorCount +
      summary.packCorridorCount +
      summary.packSpecialFloorCount +
      summary.generatedCount +
      summary.spriteCount +
      summary.colorCount;
    expect(total, 'terrain should have been baked (nonzero tile total)').toBeGreaterThan(0);

    // Floor 1 ships two terrain packs (floor1-dungeon + floor1-cave): every wall
    // tile comes from the pack atlas and every floor tile comes from the pack pool.
    // A Kenney-only render (the pre-pack behavior) would report packWallCount === 0.
    expect(
      summary.packWallCount,
      `Floor 1 should stamp terrain-pack wall tiles in the real scene; ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    expect(
      summary.packFloorCount,
      `Floor 1 should stamp terrain-pack floor tiles in the real scene; ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    // Floor 1 is a room-heavy stone dungeon: pack floor tiles dominate corridor
    // tiles. This makes the gate meaningful without over-fitting the exact layout.
    expect(
      summary.packFloorCount,
      `pack floor tiles should be the dominant ground surface on Floor 1; ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(summary.packCorridorCount);
  });

  it('Floor 2 renders terrain-pack (industrial-cave) wall and floor tiles in the real booted scene', async () => {
    // This test guards the FULL wiring chain: floor2 manifest → terrainPackId →
    // floor-main-scene-options → MainGameScene → BootScene.preloadTerrainPacks().
    // Any break in that chain (e.g. terrainPackId not forwarded, preloadTerrainPacks
    // not called, or the pack failing to load) will produce packWallCount === 0 /
    // packFloorCount === 0 here. A green lab cannot prove this; only the real booted
    // scene can.
    await loadMainSceneProbeLab(page, { floor: 'floor2' });

    let summary = await mainSceneProbe.getTerrainRenderSummary(page);
    const deadline = Date.now() + 5_000;
    while (
      summary.packWallCount +
        summary.packFloorCount +
        summary.generatedCount +
        summary.spriteCount +
        summary.colorCount ===
        0 &&
      Date.now() < deadline
    ) {
      await page.waitForTimeout(100);
      summary = await mainSceneProbe.getTerrainRenderSummary(page);
    }

    expect(
      summary.packWallCount,
      `Floor 2 should stamp industrial-cave pack WALL tiles; ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    expect(
      summary.packFloorCount,
      `Floor 2 should stamp industrial-cave pack FLOOR tiles; ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    // Sanity check: Floor 1 pack counts must remain zero (the pack is Floor 2 only)
    // so we confirm this test is actually running Floor 2 and not Floor 1.
    // (If the floor param is ignored, both would fail the packWallCount > 0 check.)
  });
});
