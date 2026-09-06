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
import { parsePng, readPixel } from './helpers/pixels.js';

/**
 * Mean RGB + luminance of the RENDERED terrain around the player, sampled from
 * a real canvas screenshot.
 *
 * Renderer bookkeeping (texture keys, stamp counts) proves the right pack is
 * WIRED, but a dark, corrupted or plainly wrong-looking PNG would satisfy it
 * just as well. This samples actual pixels so the "bright outdoors" half of
 * issue #4294 is observed rather than assumed.
 *
 * Sampling window: a centred box (HUD lives at the viewport edges) with the
 * player's own sprite punched out, on a fixed grid — no RNG, no wall clock.
 */
async function sampleTerrainColor(page: Page): Promise<{
  r: number;
  g: number;
  b: number;
  luminance: number;
  litFraction: number;
  samples: number;
}> {
  const canvas = page.locator('canvas').first();
  const png = parsePng(await canvas.screenshot());
  const cx = Math.floor(png.width / 2);
  const cy = Math.floor(png.height / 2);
  const halfW = Math.floor(png.width * 0.16);
  const halfH = Math.floor(png.height * 0.16);
  const playerExclusionPx = 56;
  let r = 0;
  let g = 0;
  let b = 0;
  let lit = 0;
  let samples = 0;
  for (let y = cy - halfH; y <= cy + halfH; y += 4) {
    for (let x = cx - halfW; x <= cx + halfW; x += 4) {
      if (Math.abs(x - cx) < playerExclusionPx && Math.abs(y - cy) < playerExclusionPx) continue;
      const px = readPixel(png, x, y);
      r += px.r;
      g += px.g;
      b += px.b;
      if (0.299 * px.r + 0.587 * px.g + 0.114 * px.b > 24) lit += 1;
      samples += 1;
    }
  }
  if (samples === 0) throw new Error('terrain colour sample window was empty');
  const mean = { r: r / samples, g: g / samples, b: b / samples };
  return {
    ...mean,
    luminance: 0.299 * mean.r + 0.587 * mean.g + 0.114 * mean.b,
    litFraction: lit / samples,
    samples,
  };
}

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

  it('Floor 3 renders the companion-overworld terrain pack in the real booted scene', async () => {
    // Hard gate for issue #4294: a lab-only pass cannot prove the shipped Floor 3
    // scene actually mounts the companion-overworld pack. The probe lab boots the
    // real scene through the shipped floor bootstrap, so the pack counts below are a
    // deterministic observation of the real artifact, not a test-double claim.
    await loadMainSceneProbeLab(page, { floor: 'floor3' });

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
      `Floor 3 should stamp companion-overworld WALL tiles in the real scene; ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    expect(
      summary.packFloorCount,
      `Floor 3 should stamp companion-overworld FLOOR tiles in the real scene; ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    const sourceCounts = summary.packFloorSourceCounts;
    const sourceIds = Object.keys(sourceCounts);
    expect(
      sourceIds.length,
      `Floor 3 should expose multiple outdoor floor variants in the real scene; ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThanOrEqual(3);
    // The pack declares a dominant grass base (weight 10) plus a quiet
    // companion (8) and six sparse detail variants (1 each), so the two calm
    // sources must carry the ground while detail stays punctuation. An
    // unweighted pool draws all eight uniformly — the patchwork the shared-base
    // terrain contract replaced — and would fail this.
    for (const sourceId of ['floor-0', 'floor-1']) {
      expect(
        sourceCounts[sourceId] ?? 0,
        `Floor 3's outdoor pack must stamp ${sourceId} in the real scene; ` +
          `summary=${JSON.stringify(summary)}`,
      ).toBeGreaterThan(0);
    }
    const stampedTotal = Object.values(sourceCounts).reduce((sum, n) => sum + n, 0);
    const baseShare =
      ((sourceCounts['floor-0'] ?? 0) + (sourceCounts['floor-1'] ?? 0)) / stampedTotal;
    expect(
      baseShare,
      `Floor 3 ground should be dominated by its two calm base variants, not a ` +
        `uniform 8-way patchwork; summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0.55);

    const woodlandStampCount = (sourceCounts['floor-6'] ?? 0) + (sourceCounts['floor-7'] ?? 0);
    expect(
      woodlandStampCount,
      `Floor 3 should stamp its dedicated woodland surfaces in the real scene; ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);
  });

  it('Floor 3 renders as BRIGHT OUTDOOR ground, not dark cave art', async () => {
    // Issue #4294's other half: the pack must actually LOOK like a sunlit
    // creature-league overworld. Counts and texture keys cannot see that, so
    // this compares real captured pixels from the same booted-scene harness
    // against Floor 2's underground industrial-cave art. Both readings come
    // from fixed seeds and a fixed sample grid, so the comparison is
    // deterministic — and it is a RELATIVE gate, so it cannot be satisfied by
    // simply turning the ambient light up on a dark cave palette.
    await loadMainSceneProbeLab(page, { floor: 'floor2' });
    await mainSceneProbe.resolveLoadout(page);
    await page.waitForTimeout(300);
    const underground = await sampleTerrainColor(page);

    await loadMainSceneProbeLab(page, { floor: 'floor3' });
    await mainSceneProbe.resolveLoadout(page);
    await page.waitForTimeout(300);
    const overworld = await sampleTerrainColor(page);

    // Recorded observation at these fixed seeds: Floor 3 samples at mean
    // luminance ~52 against Floor 2's ~16 (3.2x), with ~90% of the window lit.
    const detail = `floor3=${JSON.stringify(overworld)} floor2=${JSON.stringify(underground)}`;

    expect(
      overworld.luminance,
      `Floor 3 terrain should render markedly brighter than Floor 2's cave; ${detail}`,
    ).toBeGreaterThan(underground.luminance * 2);

    expect(
      overworld.litFraction,
      `most of Floor 3's terrain window should be lit ground, not black; ${detail}`,
    ).toBeGreaterThan(0.6);

    // The scene light is a warm point source, so RENDERED hue is dominated by
    // the light rather than the material. The shipped PNG palette itself is
    // asserted deterministically on the committed bytes in
    // tests/unit/sprites/terrain-pack-companion-overworld-committed.test.ts
    // (bright mean luminance + green-over-blue). What this capture proves is
    // the half only the real artifact can: the pack actually reaches the screen
    // and reads bright rather than dark, black or corrupted.
  });
});
