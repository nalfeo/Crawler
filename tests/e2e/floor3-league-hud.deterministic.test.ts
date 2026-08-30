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

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Bounds, b: Bounds, tolerance = 0.5): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > tolerance &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > tolerance
  );
}

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

  it('mounts the league bracket clear of the floor timer and projects minimap markers', async () => {
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
        (s) => s.visible && s.bounds !== null,
        'mounted Floor 3 league bracket HUD',
      );
      expect(mounted.phase).toBe('studios');
      expect(mounted.headline).toMatch(/^STUDIOS · \d+\/\d+$/);
      expect(mounted.detail.length).toBeGreaterThan(0);
      expect(mounted.bracket).toHaveLength(4);
      expect(mounted.bracket.every((pip) => pip === 'pending')).toBe(true);

      // Floor 3 does NOT hide the floor timer, so the two top-center panels
      // must be laid out one below the other, never stacked on each other.
      expect(mounted.timerPanel).not.toBeNull();
      const panel = mounted.bounds!;
      const timer = mounted.timerPanel!;
      expect(overlaps(panel, timer), 'league panel must not overlap the floor timer').toBe(false);
      expect(panel.y).toBeGreaterThanOrEqual(timer.y + timer.height - 0.5);
      expect(panel.x).toBeGreaterThanOrEqual(-0.5);
      expect(panel.x + panel.width).toBeLessThanOrEqual(1280.5);

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
    } finally {
      await closeQuietly(context);
    }
  }, 120_000);
});
