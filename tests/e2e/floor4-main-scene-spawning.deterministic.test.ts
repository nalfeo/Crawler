import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { E2E_LAB_BASE_URL } from './e2e-constants.js';
import type { MainSceneProbeApi } from '../../src/labs/main-scene-probe-lab/index.js';
import { getFloorManifest } from '../../src/shared/floor-registry.js';
import { buildFloor4ActWaveManifests } from '../../src/shared/floor4-waves.js';

const SEED = 404;
const MAIN_SCENE_URL = `${E2E_LAB_BASE_URL}/lab.html?lab=main-scene-probe-lab&floor=floor4&seed=${SEED}`;
const FLOOR4_CONFIG = getFloorManifest('floor4')?.floor4;
if (!FLOOR4_CONFIG) {
  throw new Error('Missing floor4 manifest config');
}
const EXPECTED_CADENCE_WAVES = 3;

/**
 * Manifest-derived floor on the authored Act 1 population, so an
 * under-spawned arena (the regression this test exists for) cannot pass.
 *
 * Each wave's `budget` is a pure function of the authored curve and the seed —
 * gate count only steers `gateIndex`, never the budget — so dividing it by the
 * act's most expensive roster entry gives the minimum number of entries the
 * manifest must contain regardless of which archetypes the seed draws. The sum
 * is then clamped to the authored live cap, which is the most the arena can
 * have physically spawned while nothing has died yet (surplus becomes debt).
 */
const ACT1_ROSTER = FLOOR4_CONFIG.waves.rosters.find((roster) => roster.act === 1);
if (!ACT1_ROSTER || ACT1_ROSTER.entries.length === 0) {
  throw new Error('Missing floor4 act 1 wave roster');
}
const MAX_ACT1_THREAT_COST = Math.max(...ACT1_ROSTER.entries.map((entry) => entry.threatCost));
const EXPECTED_MIN_SPAWNS = Math.min(
  FLOOR4_CONFIG.waves.concurrency.liveCap,
  buildFloor4ActWaveManifests(FLOOR4_CONFIG.waves, SEED, 1, 1)
    .slice(0, EXPECTED_CADENCE_WAVES)
    .reduce(
      (total, manifest) =>
        total +
        Math.min(
          FLOOR4_CONFIG.waves.budget.maxEntriesPerWave,
          Math.floor(manifest.budget / MAX_ACT1_THREAT_COST),
        ),
      0,
    ),
);
if (EXPECTED_MIN_SPAWNS <= 0) {
  throw new Error('Floor 4 act 1 cadence must author a non-empty population');
}
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
      ({ expectedCadenceWaves, expectedMinSpawns, seed }) => {
        const probe = (window as { __mainSceneProbe?: MainSceneProbeApi }).__mainSceneProbe;
        const state = probe?.getState();
        const phase = state?.floor4Arena?.phase;
        return (
          state?.floorId === 'floor4' &&
          state.worldSeed === seed &&
          phase?.kind === 'WAVES' &&
          phase.act === 1 &&
          (state.floor4Arena?.waveTelemetry.wavesReleased ?? 0) >= expectedCadenceWaves &&
          (state.floor4Arena?.waveTelemetry.enemiesSpawned ?? 0) >= expectedMinSpawns &&
          state.livingEnemyCount > 0
        );
      },
      {
        expectedCadenceWaves: EXPECTED_CADENCE_WAVES,
        expectedMinSpawns: EXPECTED_MIN_SPAWNS,
        seed: SEED,
      },
      { timeout: CADENCE_TIMEOUT_MS, polling: 100 },
    );

    const state = await page.evaluate(() => {
      const probe = (window as { __mainSceneProbe?: MainSceneProbeApi }).__mainSceneProbe;
      if (!probe) throw new Error('__mainSceneProbe not available');
      return probe.getState();
    });

    expect(state.floorId).toBe('floor4');
    expect(state.worldSeed).toBe(SEED);
    expect(state.floor4Arena?.timeline[0]?.phase.kind).toBe('COUNTDOWN');
    expect(state.floor4Arena?.timeline[0]?.reason).toBe('floor4-initialized');
    expect(state.floor4Arena?.phase).toEqual({ kind: 'WAVES', act: 1 });
    expect(state.floor4Arena?.waveTelemetry.wavesReleased).toBeGreaterThanOrEqual(
      EXPECTED_CADENCE_WAVES,
    );
    expect(state.floor4Arena?.waveTelemetry.enemiesSpawned).toBeGreaterThanOrEqual(
      EXPECTED_MIN_SPAWNS,
    );
    expect(state.elapsedMs).toBeLessThanOrEqual(CADENCE_TIMEOUT_MS);
    expect(state.enemyCount).toBeGreaterThan(0);
    expect(state.livingEnemyCount).toBeGreaterThan(0);
  }, 90_000);
});
