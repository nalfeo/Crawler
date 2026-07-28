/**
 * Floor 2 terrain-cohesion render guard (real MainGameScene).
 *
 * A green unit test proves `pickPoolCombo`/`pickWallAccentSelection` satisfy
 * their contracts in isolation; it does NOT prove the REAL Floor 2 floor
 * (`src/shared/data/floors/floor2.manifest.json` → `terrainPackId:
 * 'industrial-cave'`) actually renders that way when booted through the
 * shipped bootstrap (BootScene preloads the pack → MainGameScene bakes the
 * terrain in `drawFloorTerrain()`). This suite closes that gap the same way
 * `terrain-generated-tiles.test.ts` does for the generated/pack wall+floor
 * stamping seam.
 *
 * GATE CHANGE (approved by the human 2026-07-26). This suite previously
 * required ">=8 sources and >=24 distinct source+transform combos" on the real
 * bake. That metric was the bug: maximising distinct combinations over eight
 * INDEPENDENTLY-generated materials is precisely what produced the patchwork
 * the human rejected in gameplay screenshots ("the variations do not look
 * cohesive... there's no blending"). Cohesion is now structural — every variant
 * is the shared base plus interior-only detail, asserted byte-for-byte in
 * `tests/unit/sprites/terrain-pack-committed.test.ts` — and this suite instead
 * asserts the DISTRIBUTION the renderer actually produces: quiet ground
 * dominant, detail sparse.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('Floor 2 terrain-cohesion render guard (industrial-cave shared-base pools)', () => {
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

  it('bakes a base-dominant floor field (65-85% quiet, 15-35% detail) and a 15-25% wall-accent density in the real booted Floor 2 scene', async () => {
    await loadMainSceneProbeLab(page, { floor: 'floor2' });

    let summary = await mainSceneProbe.getTerrainRenderSummary(page);
    const deadline = Date.now() + 5_000;
    while (summary.packWallCount + summary.packFloorCount === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
      summary = await mainSceneProbe.getTerrainRenderSummary(page);
    }

    // Baseline sanity (also covered by terrain-generated-tiles.test.ts, kept
    // here so a failure in THIS suite is self-explanatory).
    expect(summary.packWallCount, `summary=${JSON.stringify(summary)}`).toBeGreaterThan(0);
    expect(summary.packFloorCount, `summary=${JSON.stringify(summary)}`).toBeGreaterThan(0);

    // --- Base-dominant distribution ---
    // The quiet-ground class has TWO members: `floor-0` (plain base, weight 10)
    // and `floor-1` (quiet mottle, weight 8). Both are calm, seamless tiles that
    // read as "background" — they are deliberately separated so seam-closure is
    // provable for each independently. `floor-2..7` (weight 1 each) are sparse
    // punctuation. The PR gate is therefore "quiet-ground CLASS (floor-0 +
    // floor-1) covers 65–85% of floor tiles", not "floor-0 alone".
    const counts = summary.packFloorSourceCounts;
    const totalFloor = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(totalFloor, `floor source counts=${JSON.stringify(counts)}`).toBeGreaterThan(0);

    const quietCount = (counts['floor-0'] ?? 0) + (counts['floor-1'] ?? 0);
    const quietShare = quietCount / totalFloor;
    const context_ = `sourceCounts=${JSON.stringify(counts)} total=${totalFloor}`;
    expect(
      quietShare,
      `quiet ground (floor-0 + floor-1) must dominate the field; ${context_}`,
    ).toBeGreaterThanOrEqual(0.65);
    expect(quietShare, `detail must not be starved out entirely; ${context_}`).toBeLessThanOrEqual(
      0.85,
    );

    // Within the quiet class, `floor-0` (weight 10) must be the single most
    // common variant — it is the border-match anchor for the shared-base pool
    // and should appear more often than any other individual source.
    const floor0Count = counts['floor-0'] ?? 0;
    const floor1Count = counts['floor-1'] ?? 0;
    expect(
      floor0Count,
      `floor-0 must be the single most common variant (weight 10 > floor-1 weight 8); ${context_}`,
    ).toBeGreaterThan(floor1Count);

    // Every detail variant still reaches the real bake — a weight regression
    // that silently drops one would otherwise pass the band above.
    for (let i = 2; i < 8; i += 1) {
      expect(
        counts[`floor-${i}`] ?? 0,
        `floor-${i} missing from bake; ${context_}`,
      ).toBeGreaterThan(0);
    }

    // Transforms are still exercised (cheap extra variety on identical borders).
    expect(
      Object.keys(summary.packFloorTransformCounts).length,
      `expected multiple transforms in use; transformCounts=${JSON.stringify(
        summary.packFloorTransformCounts,
      )}`,
    ).toBeGreaterThan(1);

    // --- Wall-accent density (unchanged 15-25% target) ---
    const accentDensity = summary.packWallAccentedCount / summary.packWallCount;
    expect(
      accentDensity,
      `wall-accent density out of the required 15-25% band; ` +
        `accented=${summary.packWallAccentedCount} total=${summary.packWallCount} density=${accentDensity}`,
    ).toBeGreaterThanOrEqual(0.15);
    expect(accentDensity).toBeLessThanOrEqual(0.25);

    // All 4 accent variants represented among accented walls.
    const accentIds = Object.keys(summary.packWallAccentCounts);
    expect(
      accentIds.length,
      `expected all 4 wall-accent variants to appear; counts=${JSON.stringify(
        summary.packWallAccentCounts,
      )}`,
    ).toBe(4);
  });
});
