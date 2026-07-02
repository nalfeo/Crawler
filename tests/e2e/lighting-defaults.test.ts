/**
 * Lighting-defaults runtime observation (rule #10).
 *
 * The shipped lighting defaults and the per-floor ambient override can only be
 * proven in a running scene: `ambient` is applied at draw time (it is NOT baked
 * into the light-field structure) and `stepPx` only takes effect once the field
 * is built. So this suite boots the real MainGameScene through the shipped floor
 * bootstrap (`createFloor1MainSceneOptions`, via `main-scene-probe-lab`) and
 * reads the live `window.__floor1Debug.lighting` seam:
 *
 *   - `getConfig()` must equal the new DEFAULT_LIGHTING_CONFIG, with `ambient`
 *     overridden to Floor 1's per-floor value (0.2).
 *   - `getPerf().fieldStepPx` must equal 4 — proof the light field was actually
 *     BUILT with the override's stepPx (the apply-before-drawFloorTerrain
 *     ordering), not merely stored on the config object.
 *
 * Because Floor 1's authored ambient (0.2) happens to equal the engine default,
 * the boot above can't by itself prove the per-floor override is *applied* rather
 * than merely defaulted. A second case boots with a DISTINGUISHING ambient (0.5,
 * via the probe lab's `?ambient=` seam) and asserts the live config reflects it —
 * so it fails if `options.lightingConfig` is ignored or the apply call is removed.
 *
 * Determinism: the lab boots with a fixed seed and the reads are pure config /
 * field-structure values — no wall-clock or RNG enters any assertion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab } from './helpers/main-scene-probe.js';

interface LightingConfigShape {
  stepPx: number;
  ambient: number;
  sourceRadiusPx: number;
  sourceIntensity: number;
  falloffExponent: number;
  softness: boolean;
  updateEveryNFrames: number;
  autoAdjustQuality: boolean;
  targetComputeMs: number;
}

interface LightingPerfShape {
  computeMsAvg: number;
  stepPx: number;
  fieldStepPx: number;
  updateEveryNFrames: number;
}

interface LightingDebugWindow {
  __floor1Debug?: {
    lighting: {
      getConfig: () => LightingConfigShape;
      getPerf: () => LightingPerfShape;
    };
  };
}

describe('shipped lighting defaults', () => {
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

  it('boots the real scene with the tuned defaults and Floor 1 per-floor ambient', async () => {
    await loadMainSceneProbeLab(page);

    // __floor1Debug is set at the end of MainGameScene.create(); the probe's
    // ready() flips there too, but guard explicitly so a read never races boot.
    await page.waitForFunction(
      () => Boolean((window as unknown as LightingDebugWindow).__floor1Debug?.lighting),
      undefined,
      { timeout: 10_000, polling: 100 },
    );

    const result = await page.evaluate(() => {
      const lighting = (window as unknown as LightingDebugWindow).__floor1Debug!.lighting;
      return { config: lighting.getConfig(), perf: lighting.getPerf() };
    });

    // Global defaults tuned in the AI Runner Lab.
    expect(result.config.stepPx).toBe(4);
    expect(result.config.sourceRadiusPx).toBe(200);
    expect(result.config.sourceIntensity).toBe(0.6);
    expect(result.config.falloffExponent).toBe(2.5);
    expect(result.config.softness).toBe(true);
    expect(result.config.updateEveryNFrames).toBe(1);
    expect(result.config.autoAdjustQuality).toBe(true);
    expect(result.config.targetComputeMs).toBe(10);

    // Per-floor ambient override (Floor 1 ships 0.2). This is the key
    // end-to-end proof, since ambient is applied at draw time.
    expect(result.config.ambient).toBe(0.2);

    // Proof the light field was actually built with the override's stepPx.
    expect(result.perf.fieldStepPx).toBe(4);
    expect(result.perf.stepPx).toBe(4);
  });

  it('applies a distinguishing per-floor ambient end-to-end (proves options.lightingConfig is used)', async () => {
    // 0.5 differs from BOTH the engine default ambient (0.2) and Floor 1's
    // authored 0.2, so this fails if the scene ignores options.lightingConfig or
    // the apply-before-drawFloorTerrain call is removed — in either case ambient
    // would fall back to the field-initialized default of 0.2.
    const distinguishingAmbient = 0.5;
    await loadMainSceneProbeLab(page, { ambient: distinguishingAmbient });

    await page.waitForFunction(
      () => Boolean((window as unknown as LightingDebugWindow).__floor1Debug?.lighting),
      undefined,
      { timeout: 10_000, polling: 100 },
    );

    const config = await page.evaluate(() =>
      (window as unknown as LightingDebugWindow).__floor1Debug!.lighting.getConfig(),
    );

    // The override merges over DEFAULT: ambient takes the distinguishing value
    // while the tuned defaults (e.g. stepPx) remain untouched.
    expect(config.ambient).toBe(distinguishingAmbient);
    expect(config.stepPx).toBe(4);
  });
});
