/**
 * Real-artifact guard for Floor 3 companion/prop depth ordering (#4422).
 *
 * Boots the shipped Floor 3 MainGameScene through main-scene-probe-lab, resolves
 * the real starter-Companion loadout, overlaps that Companion with real spawned
 * Prop entities, and reads the Phaser display objects after PhaserBridge sync.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';
import { ENTITY_DEPTH, PLAYER_DEPTH } from '../../src/shared/render-depths.js';
import type { Floor3CompanionPropDepthProbe } from '../../src/labs/main-scene-probe-lab/index.js';

async function waitForDepthProbe(page: Page): Promise<Floor3CompanionPropDepthProbe> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = await mainSceneProbe.getFloor3CompanionPropDepthProbe(page);
    if (probe === null) {
      await mainSceneProbe.advanceSimulationFrames(page, 1);
      continue;
    }
    if (
      probe.companionDepth !== null &&
      probe.backPropDepth !== null &&
      probe.frontPropDepth !== null
    ) {
      return probe;
    }
    await mainSceneProbe.advanceSimulationFrames(page, 1);
  }
  throw new Error('Timed out waiting for Floor 3 companion/prop depth probe to render');
}

describe('MainGameScene Floor 3 companion/prop depth ordering', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(page);
    await closeQuietly(context);
    await closeQuietly(browser);
  });

  it('renders background props behind companions and foreground props as strict occluders', async () => {
    await loadMainSceneProbeLab(page, { floor: 'floor3' });

    const arranged = await mainSceneProbe.primeFloor3CompanionPropDepthProbe(page);
    expect(arranged).not.toBeNull();
    await mainSceneProbe.advanceSimulationFrames(page, 1);

    const canvas = page.locator('canvas').first();
    const renderedEvidence = await canvas.screenshot();
    expect(renderedEvidence.byteLength).toBeGreaterThan(1_000);

    const observed = await waitForDepthProbe(page);
    expect(observed.backgroundOverlapsCompanion).toBe(true);
    expect(observed.foregroundOverlapsCompanion).toBe(true);
    expect(observed.backPropDepth).toBeLessThan(ENTITY_DEPTH);
    expect(observed.companionDepth).toBe(ENTITY_DEPTH);
    expect(observed.frontPropDepth).toBeGreaterThan(ENTITY_DEPTH);
    expect(observed.frontPropDepth).toBeLessThan(PLAYER_DEPTH);
    expect(observed.backPropDepth).toBeLessThan(observed.companionDepth!);
    expect(observed.companionDepth).toBeLessThan(observed.frontPropDepth!);
  }, 120_000);
});
