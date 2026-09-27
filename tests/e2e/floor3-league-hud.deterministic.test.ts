/**
 * Real MainGameScene regression for Floor 3 slice 14: Studio objectives use
 * the standard tracker, ally dots reach both minimap surfaces, and defeating
 * a Studio updates the quest/waypoint and semantic marker together. A paused,
 * fixed-seed pixel check proves the green ally glyph reaches the rendered radar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { parsePng, regionContainsColor } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
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

  it('uses the quest tracker instead of a Studios counter and draws distinct allies', async () => {
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
        'mounted Floor 3 league bracket HUD',
      );
      expect(mounted.phase).toBe('studios');
      expect(mounted.visible).toBe(false);
      expect(mounted.bounds).toBeNull();
      expect(mounted.questTrackerText).toMatch(/Defeat.*Studio/);
      expect(mounted.timerPanel).not.toBeNull();
      const quests = await mainSceneProbe.getActiveQuestIds(page);
      expect(quests.some((id) => id.startsWith('floor3-studio-'))).toBe(true);
      await expect
        .poll(async () => {
          const state = await mainSceneProbe.getFloor3LeagueHudState(page);
          return state.entityMarkers.filter((marker) => marker.ally);
        })
        .not.toHaveLength(0);
      const radar = await mainSceneProbe.getFloor3LeagueHudState(page);
      for (const marker of radar.entityMarkers.filter((marker) => marker.ally)) {
        expect(marker.color).toBe(0x4ade80);
        expect(marker.surface).toBe('radar');
      }
      expect(
        radar.entityMarkers
          .filter((marker) => !marker.ally)
          .every((marker) => marker.color !== 0x4ade80),
      ).toBe(true);
      await mainSceneProbe.setSimulationPaused(page, true);
      await page.evaluate(() => window.__mainSceneProbe!.separateFloor3AllyMarker());
      const radarBounds = (await mainSceneProbe.getSafeAreaLayout(page)).surfaces.find(
        (surface) => surface.name === 'radar',
      )!.bounds;
      await expect
        .poll(async () => {
          const png = parsePng(await page.locator('#lab-canvas canvas').screenshot());
          const sx = png.width / 1280;
          const sy = png.height / 720;
          return regionContainsColor(
            png,
            {
              x: Math.floor(radarBounds.x * sx),
              y: Math.floor(radarBounds.y * sy),
              w: Math.ceil(radarBounds.width * sx),
              h: Math.ceil(radarBounds.height * sy),
            },
            { r: 0x4a, g: 0xde, b: 0x80 },
            5,
          );
        })
        .toBe(true);
      await page.screenshot({ path: 'files/floor3-ux-after.png' });
      await mainSceneProbe.setSimulationPaused(page, false);

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
      const studioId = await page.evaluate(() => window.__mainSceneProbe!.knockOutFloor3Studio());
      expect(studioId).not.toBeNull();
      // A defeat can open the standard poach modal, which temporarily hides the HUD.
      await waitForModalKind(page, 'floor3-poach', 'Studio defeat poach');
      await page.keyboard.press('Enter');
      const cleared = await waitForLeagueHud(
        page,
        (state) =>
          state.markers.some(
            (marker) => marker.id === `studio:${studioId}` && marker.state === 'cleared',
          ),
        'canonical Studio marker cleared',
      );
      expect(cleared.studiosDefeated).toBe(1);
      expect(cleared.visible).toBe(false);
      expect(await mainSceneProbe.getActiveQuestIds(page)).not.toContain(
        `floor3-studio-${studioId}`,
      );
      expect(await mainSceneProbe.getQuestWaypointIds(page)).not.toContain(
        `floor3-studio-${studioId}`,
      );
      // Both map surfaces share allegiance styling.
      await page.keyboard.press('m');
      await expect
        .poll(async () => (await mainSceneProbe.getFloor3LeagueHudState(page)).mapOverlayOpen)
        .toBe(true);
      const overlay = await mainSceneProbe.getFloor3LeagueHudState(page);
      const allies = overlay.entityMarkers.filter((marker) => marker.ally);
      expect(allies.length).toBeGreaterThan(0);
      expect(
        allies.every((marker) => marker.color === 0x4ade80 && marker.surface === 'overlay'),
      ).toBe(true);
    } finally {
      await closeQuietly(context);
    }
  }, 120_000);
});
