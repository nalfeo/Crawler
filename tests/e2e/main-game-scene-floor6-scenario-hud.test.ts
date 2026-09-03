/**
 * Real-scene e2e coverage for the Floor 6 generic scenario HUD strip
 * (`getFloor6HudSnapshot` → `MainGameScene.updateScenarioHudSnapshot`).
 *
 * Prior coverage for this surface was source-string-only (asserting the
 * wiring function names appeared in the compiled bytecode) plus headless
 * simulation of the underlying state, neither of which boots the real
 * Phaser scene or observes actual rendered text/bounds/cue behavior. This
 * spec boots the shipped `MainGameScene` via the probe lab and asserts:
 *  - the HUD strip is visible with real text and on-canvas bounds at
 *    supported viewport sizes, and does not clip the ability bar or the
 *    bottom-centre interaction hint;
 *  - the `vfx` cue latch fires once when the Deadline finale phase is
 *    reached and clears itself after its bounded flash window, instead of
 *    staying visible for as long as the phase persists.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { GAME_H, GAME_W } from './e2e-constants.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';
import type { ScenarioHudProbeState } from '../../src/labs/main-scene-probe-lab/index.js';
import { boundsOverlap } from '../../src/engine/navigation-hud-layout.js';

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 960, height: 540 },
] as const;
const LAB_BASE_URL = process.env.FLOOR6_HUD_LAB_BASE_URL;

async function waitForScenarioHud(
  page: Page,
  predicate: (state: ScenarioHudProbeState) => boolean,
  label: string,
): Promise<ScenarioHudProbeState> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = await mainSceneProbe.getScenarioHudState(page);
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
  phase: string,
): Promise<void> {
  const evidenceDir = process.env.FLOOR6_HUD_EVIDENCE_DIR;
  if (!evidenceDir) {
    return;
  }
  await mkdir(evidenceDir, { recursive: true });
  await page.screenshot({
    path: join(evidenceDir, `floor6-hud-${viewport.width}x${viewport.height}-${phase}.png`),
  });
}

describe('MainGameScene Floor 6 scenario HUD strip', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  for (const viewport of VIEWPORTS) {
    it(`renders visible text and clipping-free bounds at ${viewport.width}x${viewport.height}`, async () => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        expect(page.viewportSize()).toEqual(viewport);
        await loadMainSceneProbeLab(page, { floor: 'floor6' }, LAB_BASE_URL);

        const hud = await waitForScenarioHud(
          page,
          (state) => state.visible && state.bounds !== null && state.text !== null,
          'Floor 6 scenario HUD strip to render',
        );
        await mainSceneProbe.setSimulationPaused(page, true);

        // Real rendered copy, not a source-string match: the objective line
        // authored in getFloor6HudPresentation must actually reach the canvas.
        expect(hud.text).toContain('Protect the Broadcast Relay');

        const canvasRect = await page.locator('#lab-canvas canvas').boundingBox();
        expect(canvasRect).not.toBeNull();
        const bounds = hud.bounds!;
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

        // No clipping against the two other bottom-of-screen HUD surfaces
        // this new strip shares canvas real estate with.
        const surfaces = (await mainSceneProbe.getSafeAreaLayout(page)).surfaces;
        const bottomCenter = surfaces.find((surface) => surface.name === 'bottomCenter')?.bounds;
        const interactionHint = surfaces.find(
          (surface) => surface.name === 'interactionHint',
        )?.bounds;
        if (bottomCenter) {
          expect(boundsOverlap(bounds, bottomCenter)).toBe(false);
        }
        if (interactionHint) {
          expect(boundsOverlap(bounds, interactionHint)).toBe(false);
        }

        await captureEvidence(page, viewport, 'docked');
      } finally {
        await context.close();
      }
    }, 60_000);

    it(`flashes the vfx cue once and auto-clears it at ${viewport.width}x${viewport.height}`, async () => {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        await loadMainSceneProbeLab(page, { floor: 'floor6' }, LAB_BASE_URL);
        await waitForScenarioHud(
          page,
          (state) => state.visible,
          'Floor 6 scenario HUD strip to render before priming the finale phase',
        );

        // Before the Deadline finale phase, no vfx cue has fired.
        const before = await mainSceneProbe.getScenarioHudState(page);
        expect(before.vfxVisible).toBe(false);
        expect(before.cueLabels.some((label) => label.startsWith('vfx:'))).toBe(false);

        const primed = await mainSceneProbe.primeFloor6FinaleVfxCue(page);
        expect(primed).toBe(true);

        const flashed = await waitForScenarioHud(
          page,
          (state) => state.vfxVisible,
          'one-shot vfx flash to show after entering the Deadline finale phase',
        );
        expect(flashed.cueLabels.some((label) => label.startsWith('vfx:'))).toBe(true);
        await captureEvidence(page, viewport, 'vfx-flash');

        // The flash is bounded (SCENARIO_HUD_VFX_FLASH_MS = 600ms), so it must
        // clear itself even though the finale phase (and its cue) persists —
        // this is the exact bug the fix addresses: previously the strip's vfx
        // rectangle stayed visible for as long as the cue was present in the
        // snapshot instead of being a one-shot flash.
        await waitForScenarioHud(
          page,
          (state) => !state.vfxVisible,
          'one-shot vfx flash to auto-clear after its bounded flash window',
        );
        await captureEvidence(page, viewport, 'vfx-cleared');
      } finally {
        await context.close();
      }
    }, 60_000);
  }

  it('renders route direction, buildable-vs-occupied sites, tower range/tier, loot, upgrade, break-safety, and Deadline text without color-only meaning', async () => {
    const context = await browser.newContext({ viewport: VIEWPORTS[0] });
    const page = await context.newPage();
    try {
      await loadMainSceneProbeLab(page, { floor: 'floor6' }, LAB_BASE_URL);
      const initial = await waitForScenarioHud(
        page,
        (state) => state.visible && state.text !== null,
        'Floor 6 scenario HUD strip to render before priming site/phase state',
      );
      await mainSceneProbe.setSimulationPaused(page, true);

      // Routes: incoming-wave direction is spelled out as words/arrows, not
      // inferred from route color.
      expect(initial.text).toMatch(/Routes:.*route/);
      // Build sites: a vacant plinth is explicitly labeled "VACANT ... buildable"
      // before any tower is placed — readable without occupancy color coding.
      expect(initial.text).toContain('VACANT');
      expect(initial.text).toContain('buildable maintenance plinth');
      // Loot and upgrade/break-safety/Deadline presentation lines are always
      // present, independent of phase.
      expect(initial.text).toMatch(/Requisitions \d+ available/);
      expect(initial.text).toMatch(/Loot visible: \d+ requisition drops/);
      expect(initial.text).toMatch(/upgrade offers (chosen|active)/);
      expect(initial.text).toContain('Deadline pending');
      await captureEvidence(page, VIEWPORTS[0], 'initial-vacant-sites');

      // Occupying a site flips the same line from VACANT to an explicit
      // OCCUPIED label naming the tower, and surfaces its range/tier text —
      // proving buildable-vs-occupied and tower range/tier read from text,
      // not from a site or tower sprite color.
      const occupied = await mainSceneProbe.primeFloor6OccupiedSite(page);
      expect(occupied).not.toBeNull();
      const afterBuild = await waitForScenarioHud(
        page,
        (state) => state.text !== null && state.text.includes('OCCUPIED'),
        'Floor 6 scenario HUD to show the occupied build site',
      );
      expect(afterBuild.text).toContain(`OCCUPIED ${occupied!.siteId}: ${occupied!.towerId}`);
      expect(afterBuild.text).toMatch(
        new RegExp(`${occupied!.towerId} at ${occupied!.siteId}: \\d+ft`),
      );
      await captureEvidence(page, VIEWPORTS[0], 'occupied-site-tower-range');

      // Break phase: the sealed, non-hostile reset beat states its safety in
      // words ("Break safe: N live hostiles"), not merely a color change.
      const breakPrimed = await mainSceneProbe.primeFloor6BreakPhase(page);
      expect(breakPrimed).toBe(true);
      const breakState = await waitForScenarioHud(
        page,
        (state) => state.text !== null && state.text.includes('BREAK phase'),
        'Floor 6 scenario HUD to show the BREAK phase',
      );
      expect(breakState.text).toMatch(/Break safe: \d+ live hostiles/);
      await captureEvidence(page, VIEWPORTS[0], 'break-phase-safety');

      // Deadline finale: escalation is stated as text ("Deadline active: ...")
      // plus Relay danger/one-shot cue, not color alone.
      const finalePrimed = await mainSceneProbe.primeFloor6FinaleVfxCue(page);
      expect(finalePrimed).toBe(true);
      const finaleState = await waitForScenarioHud(
        page,
        (state) => state.text !== null && state.text.includes('Deadline active'),
        'Floor 6 scenario HUD to show the Deadline finale escalation',
      );
      expect(finaleState.text).toMatch(/Deadline active: .* on/);
      await captureEvidence(page, VIEWPORTS[0], 'deadline-finale-escalation');
    } finally {
      await context.close();
    }
  }, 60_000);
});
