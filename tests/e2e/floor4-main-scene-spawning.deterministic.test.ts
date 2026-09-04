import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import type { MainSceneProbeApi } from '../../src/labs/main-scene-probe-lab/index.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';

const MAIN_SCENE_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=main-scene-probe-lab&floor=floor4&seed=404`;
const FLOOR4_CONFIG = getFloorManifest('floor4')?.floor4;
if (!FLOOR4_CONFIG) {
  throw new Error('Missing floor4 manifest config');
}
const EXPECTED_CADENCE_WAVES = 3;
const CADENCE_WINDOW_MS =
  FLOOR4_CONFIG.phase.countdownMs +
  FLOOR4_CONFIG.waves.cadence.intervalMs * (EXPECTED_CADENCE_WAVES - 1);
const CADENCE_TIMEOUT_MS = CADENCE_WINDOW_MS + 10_000;

describe('Floor 4 MainGameScene physical spawning (seed 404)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(MAIN_SCENE_URL, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForFunction(
      () => Boolean((window as { __mainSceneProbe?: MainSceneProbeApi }).__mainSceneProbe?.ready()),
      undefined,
      { timeout: 30_000 },
    );
  }, 120_000);

  afterAll(async () => {
    await closeQuietly(page);
    await closeQuietly(browser);
  });

  it('boots the shipped scene path with the intended non-empty wave cadence and live hostiles', async () => {
    await page.evaluate(() => {
      const probe = (window as { __mainSceneProbe?: MainSceneProbeApi }).__mainSceneProbe;
      if (!probe) throw new Error('__mainSceneProbe not available');
      probe.setSimulationPaused(false);
    });

    await page.waitForFunction(
      (expectedCadenceWaves) => {
        const probe = (window as { __mainSceneProbe?: MainSceneProbeApi }).__mainSceneProbe;
        const state = probe?.getState();
        return (
          state?.floorId === 'floor4' &&
          state.worldSeed === 404 &&
          state.floor4Arena?.timeline.some(
            (entry) => entry.phase.kind === 'WAVES' && entry.phase.act === 1,
          ) === true &&
          (state.floor4Arena.waveTelemetry.wavesReleased ?? 0) >= expectedCadenceWaves &&
          (state.floor4Arena.waveTelemetry.enemiesSpawned ?? 0) > 0 &&
          state.livingEnemyCount > 0
        );
      },
      EXPECTED_CADENCE_WAVES,
      { timeout: CADENCE_TIMEOUT_MS, polling: 100 },
    );

    const state = await page.evaluate(() => {
      const probe = (window as { __mainSceneProbe?: MainSceneProbeApi }).__mainSceneProbe;
      if (!probe) throw new Error('__mainSceneProbe not available');
      return probe.getState();
    });

    expect(state.floorId).toBe('floor4');
    expect(state.worldSeed).toBe(404);
    expect(state.floor4Arena?.timeline[0]?.phase.kind).toBe('COUNTDOWN');
    expect(state.floor4Arena?.timeline[0]?.reason).toBe('floor4-initialized');
    expect(state.floor4Arena?.waveTelemetry.wavesReleased).toBeGreaterThanOrEqual(
      EXPECTED_CADENCE_WAVES,
    );
    expect(state.floor4Arena?.waveTelemetry.enemiesSpawned).toBeGreaterThan(0);
    expect(state.elapsedMs).toBeLessThanOrEqual(CADENCE_TIMEOUT_MS);
    expect(state.enemyCount).toBeGreaterThan(0);
    expect(state.livingEnemyCount).toBeGreaterThan(0);
  }, 90_000);
});
