/**
 * Real-artifact guard for the Floor 3 Companion League HUD (game-design §15
 * surfaces 10, 11 and 13).
 *
 * The unit tests cover the pure view-model builders only; a builder can never
 * prove the shipped `MainGameScene` mounts the panel, that the panel clears the
 * floor timer Floor 3 still shows (unlike Floor 4, whose scenario hides it), or
 * that the semantic minimap markers reach the docked radar without the player
 * ever opening the full map overlay.
 *
 * Determinism: the probe lab boots with a fixed world seed, every assertion
 * reads mounted-widget state (never wall-clock or RNG), and the only timing
 * dependence is bounded polling for the scene's next update tick.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
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

  it('uses the standard quest tracker instead of a Studio scoreboard and projects minimap markers', async () => {
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
        (s) => s.phase === 'studios',
        'Floor 3 Studio progression',
      );
      expect(mounted.visible).toBe(false);
      expect(mounted.bounds).toBeNull();
      const ux = await page.evaluate(() => window.__mainSceneProbe!.getFloor3UxState());
      expect(ux.texts.some(({ text }) => /^STUDIOS/i.test(text))).toBe(false);
      expect(ux.texts.find(({ name }) => name === 'quest-tracker-body')?.text).toContain('Studio');
      expect(mounted.bracket.every((pip) => pip === 'pending')).toBe(true);

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
      await mainSceneProbe.setSimulationPaused(page, true);
      const activeBefore = await mainSceneProbe.getActiveQuestIds(page);
      const studioQuest = activeBefore.find((id) => id.startsWith('floor3-studio-'))!;
      expect(studioQuest).toBeDefined();
      await page.evaluate(() => {
        window.__mainSceneProbe!.knockOutFloor3Encounter('studio');
        window.__mainSceneProbe!.advanceSimulationFrames(1);
      });
      // Read the real pipeline after a KO: canonical defeat, quest completion
      // and the docked marker must all agree, with no second progress counter.
      await expect
        .poll(async () => (await mainSceneProbe.getActiveQuestIds(page)).includes(studioQuest))
        .toBe(false);
      const completed = await page.evaluate(() => window.__mainSceneProbe!.getFloor3UxState());
      expect(completed.defeatedCount).toBe(1);
      const studioId = studioQuest.slice('floor3-studio-'.length);
      expect(completed.studios.find(({ id }) => id === studioId)?.defeated).toBe(true);
      expect(completed.markers.find(({ id }) => id === `studio:${studioId}`)?.state).toBe(
        'cleared',
      );
      expect(completed.texts.some(({ text }) => /^STUDIOS/i.test(text))).toBe(false);
      await page.screenshot({ path: 'files/floor3-studio-tracker-completed.png' });
    } finally {
      await closeQuietly(context);
    }
  }, 120_000);

  it('renders ordered Final Four intros, requires one kept Companion, and retains the bracket', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await loadMainSceneProbeLab(page, { floor: 'floor3' });
      await page.keyboard.press('Enter');
      await waitForModalKind(page, 'floor3-starter', 'starter');
      await page.keyboard.press('Enter');
      await waitForState(page, (s) => s.worldState === 'playing');
      await page.evaluate(() => {
        window.__mainSceneProbe!.unlockFloor3LeagueProbe();
        window.__mainSceneProbe!.advanceSimulationFrames(1);
      });
      const initial = await page.evaluate(() => window.__mainSceneProbe!.getFloor3UxState());
      // Acknowledge each newly unlocked Studio once through the shipped UI.
      for (let index = 0; index < initial.studios.length; index++) {
        await waitForModalKind(page, 'floor3-studio-versus', `Studio intro ${index + 1}`);
        await page.keyboard.press('Enter');
        await page.evaluate(() => window.__mainSceneProbe!.advanceSimulationFrames(1));
      }
      for (let index = 0; index < initial.studios.length; index++) {
        await page.evaluate(() => {
          window.__mainSceneProbe!.knockOutFloor3Encounter('studio');
          window.__mainSceneProbe!.advanceSimulationFrames(1);
        });
        const state = await page.evaluate(() => window.__mainSceneProbe!.getFloor3UxState());
        expect(state.defeatedCount).toBe(index + 1);
        expect(state.studios.filter(({ defeated }) => defeated)).toHaveLength(index + 1);
        // The last win opens a blocking Final Four intro and hides the map.
        // Check its rendered markers once that intro is acknowledged below.
        if (index + 1 < initial.studios.length) {
          expect(
            state.markers.filter(
              (marker) => marker.kind === 'studio' && marker.state === 'cleared',
            ),
          ).toHaveLength(index + 1);
        }
      }
      for (let round = 0; round < 4; round++) {
        await waitForModalKind(page, 'floor3-final-four-versus', `Final Four round ${round + 1}`);
        const intro = await mainSceneProbe.getModalPickerContent(page);
        expect(intro?.title).toContain(`Round ${round + 1} of 4`);
        await page.keyboard.press('Enter');
        const bracket = await waitForLeagueHud(page, (s) => s.visible, 'Final Four bracket');
        const completed = await page.evaluate(() => window.__mainSceneProbe!.getFloor3UxState());
        expect(
          completed.markers.filter(
            (marker) => marker.kind === 'studio' && marker.state === 'cleared',
          ),
        ).toHaveLength(initial.studios.length);
        expect(bracket.bracket[round]).toBe('active');
        expect(bracket.bracket.filter((pip) => pip === 'cleared')).toHaveLength(round);
        expect(bracket.bounds!.y).toBeGreaterThanOrEqual(
          bracket.timerPanel!.y + bracket.timerPanel!.height,
        );
        await page.evaluate(() => {
          window.__mainSceneProbe!.knockOutFloor3Encounter('final-four');
          window.__mainSceneProbe!.advanceSimulationFrames(1);
        });
      }
      await waitForModalKind(page, 'floor3-keep-companion', 'required champion choice');
      expect(
        (await page.evaluate(() => window.__mainSceneProbe!.getFloor3UxState())).keptEid,
      ).toBeNull();
      const picker = await mainSceneProbe.getModalPickerContent(page);
      expect(picker?.title).toBe('Best in Show');
      expect(picker?.options.length).toBeGreaterThan(0);
      await page.keyboard.press('Escape');
      expect((await mainSceneProbe.getModalPickerContent(page))?.kind).toBe(
        'floor3-keep-companion',
      );
      await page.screenshot({ path: 'files/floor3-best-in-show-picker.png' });
      await page.keyboard.press('Enter');
      const kept = await page.evaluate(() => window.__mainSceneProbe!.getFloor3UxState());
      expect(kept.companions).toContain(kept.keptEid);
      expect((await mainSceneProbe.getFloor3LeagueHudState(page)).phase).toBe('best-in-show');
    } finally {
      await closeQuietly(context);
    }
  }, 120_000);

  it('renders the season-over screen after a real party wipe', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await loadMainSceneProbeLab(page, { floor: 'floor3' });
      await page.keyboard.press('Enter');
      await waitForModalKind(page, 'floor3-starter', 'starter');
      await page.keyboard.press('Enter');
      await waitForState(page, (s) => s.worldState === 'playing');
      await page.evaluate(() => window.__mainSceneProbe!.advanceSimulationFrames(1));
      await waitForModalKind(page, 'floor3-studio-versus', 'first Studio');
      await page.keyboard.press('Enter');
      await mainSceneProbe.setPlayerFeet(page, 10_000, 10_000); // away from Rally Points
      await page.evaluate(() => {
        window.__mainSceneProbe!.knockOutFloor3Encounter('party');
        window.__mainSceneProbe!.advanceSimulationFrames(1);
      });
      await waitForState(page, (s) => s.worldState === 'game_over' && s.gameOverOpen);
      const ux = await page.evaluate(() => window.__mainSceneProbe!.getFloor3UxState());
      expect(ux.texts.some(({ text }) => text === 'Season Over')).toBe(true);
      expect(ux.texts.some(({ text }) => text.includes('Restart'))).toBe(true);
      expect(ux.texts.some(({ text }) => text.includes('Quit'))).toBe(true);
      await page.screenshot({ path: 'files/floor3-season-over.png' });
    } finally {
      await closeQuietly(context);
    }
  }, 120_000);
});
