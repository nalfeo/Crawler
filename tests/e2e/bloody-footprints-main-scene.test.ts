import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  BLOODY_FOOTPRINT_EMIT_DISTANCE_FT,
  mixBloodColors,
} from '../../src/shared/blood-surfaces.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

const RED_BLOOD = 0xcc0000;
const BLUE_BLOOD = 0x3355cc;
/** One walk step, slightly over the emit threshold so each move lays a print. */
const STEP_FT = BLOODY_FOOTPRINT_EMIT_DISTANCE_FT * 1.05;

describe('MainGameScene bloody footprints', () => {
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

  it('renders authoritative footprints in the real scene and mixes colors across pools', async () => {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    const state = await waitForState(
      page,
      (s) => s.worldState === 'playing' && s.simulationPaused,
      {
        label: 'playing + paused scene',
      },
    );
    expect(state.playerFeet).not.toBeNull();
    const start = state.playerFeet!;

    await mainSceneProbe.seedBloodPool(page, start.x, start.y, RED_BLOOD);
    await mainSceneProbe.advanceSimulationFrames(page, 1);
    await expect
      .poll(async () => (await mainSceneProbe.getBloodSurfaceSummary(page)).activeSourceColor)
      .toBe(RED_BLOOD);

    await mainSceneProbe.setPlayerFeet(page, start.x + STEP_FT, start.y);
    await mainSceneProbe.advanceSimulationFrames(page, 1);
    await mainSceneProbe.setPlayerFeet(page, start.x + STEP_FT * 2, start.y);
    await mainSceneProbe.advanceSimulationFrames(page, 1);
    await expect
      .poll(async () => (await mainSceneProbe.getBloodSurfaceSummary(page)).footprintCount)
      .toBeGreaterThan(0);

    await mainSceneProbe.seedBloodPool(page, start.x + STEP_FT * 2, start.y, BLUE_BLOOD);
    await mainSceneProbe.advanceSimulationFrames(page, 1);
    const mixed = mixBloodColors(RED_BLOOD, BLUE_BLOOD);
    await expect
      .poll(async () => (await mainSceneProbe.getBloodSurfaceSummary(page)).activeSourceColor)
      .toBe(mixed);

    await mainSceneProbe.setPlayerFeet(page, start.x + STEP_FT * 3, start.y);
    await mainSceneProbe.advanceSimulationFrames(page, 1);

    const summary = await mainSceneProbe.getBloodSurfaceSummary(page);
    expect(summary.renderedPoolCount).toBeGreaterThanOrEqual(2);
    expect(summary.renderedFootprintCount).toBe(summary.footprintCount);
    expect(summary.footprintColors).toContain(mixed);
  });
});
