/**
 * Harvestable node-sprite render guard (real MainGameScene).
 *
 * Floor-1 harvestable resource nodes (crimson-mushroom, azure-mushroom,
 * sunpetal-flower, moonbloom-flower, frost-lichen, shadow-lichen) used to render
 * as flat procedural tinted circles. This suite pins the wired behavior: booting
 * the REAL scene through the shipped floor bootstrap
 * (`createFloor1GameConfig` + `createFloor1MainSceneOptions`, the exact path the
 * game uses), every live harvestable node renders its generated sprite Image —
 * NOT the circle fallback.
 *
 * Why e2e (not a lab reimplementation): the harvest-lab draws to a plain 2D
 * canvas and does NOT use PhaserBridge, so a green lab there proves nothing about
 * the real render path. The `main-scene-probe-lab` instead HOSTS the real
 * MainGameScene, so this observes the actual engine render pipeline (per
 * AGENTS.md rule #10 "observe before done" / "lab-only validation is
 * insufficient"). The probe reports the live harvestable entity count and how
 * many display-list Images carry a harvestable brief texture; the render is
 * correct when every node is a sprite.
 *
 * Determinism: fixed `worldSeed` (PROBE_SEED), simulation frozen after the
 * loadout resolves (the scene still runs `bridge.sync()` every frame while
 * paused — see MainGameScene `simulationPaused && pendingSimulationSteps <= 0`),
 * and the assertion is an exact integer equality with no wall-clock/RNG input.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

describe('Harvestable node-sprite render guard', () => {
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

  it('renders every Floor-1 harvestable node as a generated sprite in the real scene', async () => {
    await loadMainSceneProbeLab(page);

    // Resolve the loadout so the world enters 'playing' (harvestables are live)
    // and the sim freezes. bridge.sync() still runs each frame while paused, so
    // the node Images are created/kept on the display list deterministically.
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'loadout resolved + simulation paused',
    });

    // Poll a few frames so the first post-loadout sync()/texture bind settles,
    // then require: at least one node exists AND every node renders a sprite
    // (spriteImages === nodeEntities → zero circle fallbacks).
    let summary = await mainSceneProbe.getHarvestableRenderSummary(page);
    const deadline = Date.now() + 8_000;
    while (
      (summary.nodeEntities === 0 || summary.spriteImages !== summary.nodeEntities) &&
      Date.now() < deadline
    ) {
      await page.waitForTimeout(100);
      summary = await mainSceneProbe.getHarvestableRenderSummary(page);
    }

    expect(
      summary.nodeEntities,
      'Floor 1 should spawn at least one harvestable node',
    ).toBeGreaterThan(0);
    expect(
      summary.spriteImages,
      `all ${summary.nodeEntities} harvestable nodes should render a generated sprite (no circle fallback); ` +
        `saw ${summary.spriteImages} sprite Images`,
    ).toBe(summary.nodeEntities);

    // Per-def: every harvestable TYPE that spawned nodes must render all of them
    // as sprites. A type-specific texture miss (one brief unresolved) could pass
    // the aggregate count above if another type over-counted, so pin each def.
    expect(
      summary.byDef.length,
      'at least one harvestable def should have live nodes on Floor 1',
    ).toBeGreaterThan(0);
    for (const def of summary.byDef) {
      expect(
        def.spriteImages,
        `harvestable '${def.defId}' (brief ${def.briefId}) should render all ${def.nodeEntities} ` +
          `of its live nodes as sprites; saw ${def.spriteImages}`,
      ).toBe(def.nodeEntities);
    }
  });
});
