import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { GAME_H, GAME_W } from './e2e-constants.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';
import type { FamilyHudProbeState } from '../../src/labs/main-scene-probe-lab/index.js';

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 960, height: 540 },
] as const;
const LAB_BASE_URL = process.env.HUD_FAMILY_LAB_BASE_URL;

async function waitForFamilyHud(
  page: Page,
  predicate: (state: FamilyHudProbeState) => boolean,
  label: string,
): Promise<FamilyHudProbeState> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = await mainSceneProbe.getFamilyHudState(page);
    if (predicate(state)) {
      return state;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(state)}`);
    }
    await page.waitForTimeout(80);
  }
}

async function captureEvidence(
  page: Page,
  viewport: (typeof VIEWPORTS)[number],
  phase: 'docked' | 'map-open' | 'restored',
): Promise<void> {
  const evidenceDir = process.env.HUD_FAMILY_EVIDENCE_DIR;
  if (!evidenceDir) {
    return;
  }
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: join(evidenceDir, `after-fix-${viewport.width}x${viewport.height}-${phase}.png`),
  });
}

describe('MainGameScene Floor 2 family HUD fullscreen-map gate', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  for (const viewport of VIEWPORTS) {
    it(`hides and restores the mounted family panel at ${viewport.width}x${viewport.height}`, async () => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        expect(page.viewportSize()).toEqual(viewport);
        await loadMainSceneProbeLab(page, { floor: 'floor2' }, LAB_BASE_URL);
        await mainSceneProbe.resolveLoadout(page);
        await mainSceneProbe.activateFamilyRelationships(page);

        const docked = await waitForFamilyHud(
          page,
          (state) => !state.mapOverlayOpen && state.visible && state.bounds !== null,
          'docked Floor 2 family panel',
        );
        await mainSceneProbe.setSimulationPaused(page, true);
        expect(docked.bounds).not.toBeNull();

        const canvasRect = await page.locator('#lab-canvas canvas').boundingBox();
        expect(canvasRect).not.toBeNull();
        const bounds = docked.bounds!;
        const screenBounds = {
          x: canvasRect!.x + bounds.x * (canvasRect!.width / GAME_W),
          y: canvasRect!.y + bounds.y * (canvasRect!.height / GAME_H),
          width: bounds.width * (canvasRect!.width / GAME_W),
          height: bounds.height * (canvasRect!.height / GAME_H),
        };
        expect(screenBounds.x).toBeGreaterThanOrEqual(canvasRect!.x - 1);
        expect(screenBounds.y).toBeGreaterThanOrEqual(canvasRect!.y - 1);
        expect(screenBounds.x + screenBounds.width).toBeLessThanOrEqual(
          canvasRect!.x + canvasRect!.width + 1,
        );
        expect(screenBounds.y + screenBounds.height).toBeLessThanOrEqual(
          canvasRect!.y + canvasRect!.height + 1,
        );
        await captureEvidence(page, viewport, 'docked');

        await page.keyboard.press('m');
        const mapOpen = await waitForFamilyHud(
          page,
          (state) => state.mapOverlayOpen && !state.visible && state.bounds === null,
          'family panel suppression under fullscreen map',
        );
        expect(mapOpen).toEqual({ mapOverlayOpen: true, visible: false, bounds: null });
        await captureEvidence(page, viewport, 'map-open');

        await page.keyboard.press('Escape');
        const restored = await waitForFamilyHud(
          page,
          (state) => !state.mapOverlayOpen && state.visible && state.bounds !== null,
          'family panel restoration after fullscreen map closes',
        );
        expect(restored.bounds).toEqual(docked.bounds);
        await captureEvidence(page, viewport, 'restored');
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
