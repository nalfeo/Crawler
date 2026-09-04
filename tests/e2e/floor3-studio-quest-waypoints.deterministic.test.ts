/**
 * Real-artifact guard for issue #4208: Floor 3 Studio objectives must reach
 * the player through the canonical quest tracker + waypoint-arrow system,
 * not a bespoke one-off STUDIOS surface.
 *
 * The unit tests cover `questWaypoints.ts`'s pure resolver functions and the
 * quest pack schema only; neither proves the shipped `MainGameScene` actually
 * (a) accepts a real quest into `world.questLog` the moment a Studio unlocks,
 * the same canonical path `HudQuestTracker` reads for every other floor, or
 * (b) renders a real `quest-direction-arrow:<questId>` Phaser object pointing
 * at that Studio's room. This test drives the real Floor 3 scenario through
 * its shipped intro/starter modals and reads both off the live scene.
 *
 * Determinism: the probe lab boots with a fixed world seed, every assertion
 * reads mounted-widget/world state (never wall-clock or RNG), and the only
 * timing dependence is bounded polling for the scene's next update tick.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

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

describe('MainGameScene Floor 3 Studio quest + waypoint wiring', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('accepts the first unlocked Studio into the canonical quest log and points a waypoint arrow at it', async () => {
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

      // The first unlocked Studio announces itself as a versus card; dismiss it.
      await waitForModalKind(page, 'floor3-studio-versus', 'Floor 3 Studio versus card');
      await page.keyboard.press('Enter');

      // Hard gate #1: the objective reaches the CANONICAL quest log/tracker
      // (`getActiveQuests`, the same accessor `HudQuestTracker` reads for
      // every floor) — not a one-off STUDIOS-only data path.
      await expect
        .poll(async () => mainSceneProbe.getActiveQuestIds(page), { timeout: 15_000 })
        .toEqual(expect.arrayContaining([expect.stringMatching(/^floor3-studio-/)]));

      const finalQuestIds = await mainSceneProbe.getActiveQuestIds(page);
      const studioQuestId = finalQuestIds.find((id) => id.startsWith('floor3-studio-'));
      expect(
        studioQuestId,
        `expected a floor3-studio-* quest active; got ${finalQuestIds.join(', ')}`,
      ).toBeDefined();

      // Hard gate #2: canonical waypoint guidance — the real scene's waypoint
      // projection contains the same quest. Direction arrows are intentionally
      // only rendered while the target is off-screen, so a spawn that already
      // frames the Studio must not be mistaken for missing guidance.
      await expect
        .poll(async () => mainSceneProbe.getQuestWaypointIds(page), { timeout: 15_000 })
        .toEqual(expect.arrayContaining([studioQuestId]));

      const waypoint = (await mainSceneProbe.getQuestWaypointStates(page)).find(
        (state) => state.questId === studioQuestId,
      );
      expect(waypoint, `expected a canonical waypoint for ${studioQuestId}`).toBeDefined();
      if (!waypoint) return;

      // Direction arrows are only mounted for off-screen targets. Move the
      // player deterministically far from the resolved Studio anchor so this
      // real-game assertion exercises the rendered guidance path rather than
      // accidentally passing because the target is inside the camera.
      await mainSceneProbe.setPlayerFeet(page, waypoint.x + 10_000, waypoint.y + 10_000);
      await expect
        .poll(
          async () => {
            const states = await mainSceneProbe.getVisibleQuestArrowStates(page);
            return states.find((state) => state.questId === studioQuestId) ?? null;
          },
          { timeout: 15_000 },
        )
        .not.toBeNull();

      const arrowStates = await mainSceneProbe.getVisibleQuestArrowStates(page);
      const arrow = arrowStates.find((state) => state.questId === studioQuestId);
      expect(arrow, `expected a rendered waypoint arrow for ${studioQuestId}`).toBeDefined();
      expect(Number.isFinite(arrow!.x)).toBe(true);
      expect(Number.isFinite(arrow!.y)).toBe(true);
      expect(Number.isFinite(arrow!.rotation)).toBe(true);
    } finally {
      await closeQuietly(context);
    }
  }, 120_000);
});
