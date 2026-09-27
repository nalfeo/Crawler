/**
 * Issue #3539 real-MainGameScene guard: Studio progress uses the canonical
 * tracker, with no duplicate purple counter. The seeded fixture separates
 * live map entities so actual radar pixels prove allegiance distinction.
 * Knocking out an unlocked roster lets production progression update the
 * quest, waypoint, defeat count, and semantic map marker together.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { parsePng, regionContainsColor } from './helpers/pixels.js';
import { closeQuietly, getCanvasRect } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';
import type { Floor3LeagueHudProbeState } from '../../src/labs/main-scene-probe-lab/index.js';

async function waitForModalKind(page: Page, kind: string, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const content = await mainSceneProbe.getModalPickerContent(page);
    if (content?.kind === kind) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; last content: ${JSON.stringify(content)}`);
    }
    await page.waitForTimeout(80);
  }
}

async function waitForLeagueHud(
  page: Page,
  predicate: (state: Floor3LeagueHudProbeState) => boolean,
  label: string,
): Promise<Floor3LeagueHudProbeState> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = await mainSceneProbe.getFloor3LeagueHudState(page);
    if (predicate(state)) return state;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(state)}`);
    }
    await page.waitForTimeout(80);
  }
}

describe('MainGameScene Floor 3 league HUD wiring', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('uses the canonical tracker instead of a standalone Studios counter and projects markers', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await loadMainSceneProbeLab(page, { floor: 'floor3' });
      await waitForState(page, (s) => s.floorId === 'floor3' && s.worldState === 'loadout', {
        timeoutMs: 20_000,
        label: 'Floor 3 starter-companion loadout modal',
      });

      // Resolve the real Floor 3 intro + starter picker through the shipped modals.
      await page.keyboard.press('Enter');
      await waitForModalKind(page, 'floor3-starter', 'Floor 3 starter-companion modal');
      await page.keyboard.press('Enter');
      await waitForState(page, (s) => s.floorId === 'floor3' && s.worldState === 'playing', {
        timeoutMs: 10_000,
        label: 'Floor 3 loadout confirmed',
      });
      await mainSceneProbe.setSimulationPaused(page, false);

      // Surface 10: the first unlocked Studio announces itself as a versus card.
      await waitForModalKind(page, 'floor3-studio-versus', 'Floor 3 Studio versus card');
      const versus = await mainSceneProbe.getModalPickerContent(page);
      expect(versus?.subtitle).toContain('STUDIO VERSUS');
      await page.keyboard.press('Enter');

      const mounted = await waitForLeagueHud(
        page,
        (s) => s.phase === 'studios' && s.markerKinds.length > 0,
        'Floor 3 Studio projection',
      );
      expect(mounted.visible).toBe(false);
      expect(mounted.bounds).toBeNull();
      expect(await mainSceneProbe.getActiveQuestIds(page)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^floor3-studio-/)]),
      );
      const layout = await mainSceneProbe.getSafeAreaLayout(page);
      expect(layout.surfaces.some((surface) => surface.name === 'questTracker')).toBe(true);

      // Overworld markers (surface 13) must reach the DOCKED radar, i.e.
      // without the player ever opening the full-map overlay.
      expect(mounted.mapOverlayOpen).toBe(false);
      const withMarkers = await waitForLeagueHud(
        page,
        (s) => s.markerKinds.length > 0,
        'Floor 3 semantic minimap markers on the docked radar',
      );
      expect(withMarkers.mapOverlayOpen).toBe(false);
      expect(withMarkers.markerKinds).toContain('studio');
      expect(withMarkers.markerKinds).toContain('final-four-gate');

      // Read the actual radar pixels: this green is reserved for player Companions.
      const radar = layout.surfaces.find((surface) => surface.name === 'radar')!.bounds;
      await mainSceneProbe.setSimulationPaused(page, true);
      expect(
        await page.evaluate(() => window.__mainSceneProbe!.separateFloor3MinimapMarkers()),
      ).toBe(true);
      await page.waitForTimeout(150);
      const canvas = await getCanvasRect(page);
      const shot = await page.screenshot({ path: 'files/floor3-studio-tracker-radar.png' });
      const radarPixels = {
        x: Math.floor(canvas.x + (radar.x * canvas.width) / 1280),
        y: Math.floor(canvas.y + (radar.y * canvas.height) / 720),
        w: Math.ceil((radar.width * canvas.width) / 1280),
        h: Math.ceil((radar.height * canvas.height) / 720),
      };
      const png = parsePng(shot);
      // Require every semantic color in the rendered dial: an ally/hostile or
      // ally/neutral palette collision now removes one required color and fails.
      for (const [label, color] of [
        ['ally', { r: 74, g: 222, b: 128 }],
        ['hostile', { r: 239, g: 68, b: 68 }],
        ['neutral', { r: 56, g: 189, b: 248 }],
        ['player', { r: 255, g: 255, b: 255 }],
        ['objective', { r: 252, g: 211, b: 77 }],
      ] as const) {
        expect(regionContainsColor(png, radarPixels, color, 12), `${label} radar marker`).toBe(
          true,
        );
      }

      await mainSceneProbe.setSimulationPaused(page, false);
      const studioId = await page.evaluate(() =>
        window.__mainSceneProbe!.knockOutFirstFloor3Studio(),
      );
      expect(studioId).not.toBeNull();
      await expect
        .poll(async () => (await mainSceneProbe.getFloor3LeagueHudState(page)).studiosDefeated)
        .toBe(1);
      // Defeat opens a poach picker; dismiss it so the mounted HUD resumes.
      await waitForModalKind(page, 'floor3-poach', 'Studio recruit reward');
      await page.keyboard.press('Enter');
      await expect
        .poll(
          async () =>
            (await mainSceneProbe.getFloor3LeagueHudState(page)).markers.find(
              (marker) => marker.id === `studio:${studioId}`,
            )?.state,
        )
        .toBe('cleared');
      expect(await mainSceneProbe.getActiveQuestIds(page)).not.toContain(
        `floor3-studio-${studioId}`,
      );
      expect(await mainSceneProbe.getQuestWaypointIds(page)).not.toContain(
        `floor3-studio-${studioId}`,
      );
    } finally {
      await closeQuietly(context);
    }
  }, 120_000);
});
