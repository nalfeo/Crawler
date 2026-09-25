import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

it('observes Floor 4 nearby pressure through real MainGameScene automatic combat', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await loadMainSceneProbeLab(page, { floor: 'floor4', seed: 404 });
    await mainSceneProbe.setSimulationPaused(page, true);
    const observations = [];
    for (let second = 0; second < 94; second++) {
      await mainSceneProbe.dismissProbeModal(page);
      await mainSceneProbe.advanceSimulationFrames(page, 60);
      const state = await mainSceneProbe.getState(page);
      if (state.floor4Arena?.phase.kind === 'WAVES' && !state.safeContext) {
        observations.push(state.nearbyHostileCount);
      }
      if (second === 45) {
        mkdirSync('tmp/e2e-screenshots', { recursive: true });
        await page.screenshot({ path: 'tmp/e2e-screenshots/floor4-density.png' });
      }
    }
    const state = await mainSceneProbe.getState(page);
    const mean = observations.reduce((a, b) => a + b, 0) / observations.length;
    mkdirSync('tmp/floor4-density', { recursive: true });
    writeFileSync(
      'tmp/floor4-density/main-scene.json',
      JSON.stringify(
        {
          mean,
          samples: observations.length,
          max: Math.max(...observations),
          phase: state.floor4Arena?.phase,
          living: state.livingEnemyCount,
        },
        null,
        2,
      ),
    );
    expect(observations.length).toBeGreaterThan(80);
    expect(mean).toBeGreaterThanOrEqual(8);
    expect(mean).toBeLessThanOrEqual(12);
    expect(state.floor4Arena?.phase.kind).toBe('HEADLINE');
  } finally {
    await browser.close();
  }
}, 120_000);
