/**
 * Real-artifact guard for the Floor-3 party-combat UX surfaces (game-design
 * §15 surfaces 4–8).
 *
 * The per-surface lab (`tests/e2e/floor3-party-hud.deterministic.test.ts`)
 * proves the widgets render and respond; a lab can never prove the *shipped*
 * scene mounts them or binds their keys (AGENTS.md rule #9). This suite boots
 * the real `MainGameScene` on Floor 3 through the shipped floor bootstrap
 * (`main-scene-probe-lab`), resolves the real starter-Companion loadout, and
 * then drives the real `[R]` / `[C]` key bindings, asserting the mounted HUD
 * and roster overlay respond.
 *
 * Determinism: the probe lab boots with a fixed world seed, every assertion
 * reads mounted-widget state (never wall-clock or RNG), and the only timing
 * dependence is bounded polling for the scene's next update tick.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';
import type { Floor3PartyHudProbeState } from '../../src/labs/main-scene-probe-lab/index.js';

async function waitForPartyHud(
  page: Page,
  predicate: (state: Floor3PartyHudProbeState) => boolean,
  label: string,
): Promise<Floor3PartyHudProbeState> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = await mainSceneProbe.getFloor3PartyHudState(page);
    if (predicate(state)) return state;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; last state: ${JSON.stringify(state)}`);
    }
    await page.waitForTimeout(80);
  }
}

describe('MainGameScene Floor 3 party-combat UX wiring', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('mounts the party HUD and binds the roster/command keys in the shipped scene', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await loadMainSceneProbeLab(page, { floor: 'floor3' });
      await waitForState(page, (s) => s.floorId === 'floor3' && s.worldState === 'loadout', {
        timeoutMs: 20_000,
        label: 'Floor 3 starter-companion loadout modal',
      });

      // BEFORE: no Companion recruited yet, so the party HUD stays hidden.
      const beforeStarter = await mainSceneProbe.getFloor3PartyHudState(page);
      expect(beforeStarter.hudVisible).toBe(false);
      expect(beforeStarter.rowNames).toEqual([]);

      // Resolve the real starter picker through the shipped modal.
      await page.keyboard.press('Enter');
      await waitForState(page, (s) => s.floorId === 'floor3' && s.worldState === 'playing', {
        timeoutMs: 10_000,
        label: 'Floor 3 loadout confirmed',
      });

      // AFTER: the mounted HUD shows the recruited starter.
      const docked = await waitForPartyHud(
        page,
        (s) => s.hudVisible && s.rowNames.length > 0,
        'mounted Floor 3 party HUD',
      );
      expect(docked.rowNames.every((name) => name.trim().length > 0)).toBe(true);
      expect(docked.rowNames.some((name) => name.includes('f3.'))).toBe(false);
      expect(docked.commandCapacity).toBeGreaterThanOrEqual(1);
      expect(docked.commandsInUse).toBe(0);

      // [R] opens the real roster overlay with a live detail column.
      await page.keyboard.press('r');
      const rosterOpen = await waitForPartyHud(
        page,
        (s) => s.rosterOpen,
        'Floor 3 roster overlay opened by [R]',
      );
      expect(rosterOpen.rosterEntries.length).toBe(docked.rowNames.length);
      expect(rosterOpen.rosterCursor).toBe(0);
      expect(rosterOpen.rosterDetailLineCount).toBeGreaterThan(0);

      // Escape closes it through the scene's blocking-surface handling.
      await page.keyboard.press('Escape');
      await waitForPartyHud(
        page,
        (s) => !s.rosterOpen,
        'Floor 3 roster overlay closed by [Escape]',
      );

      // [C] spends a command charge on the mounted HUD.
      await page.keyboard.press('c');
      const commanded = await waitForPartyHud(
        page,
        (s) => s.commandsInUse > 0,
        'Floor 3 companion command issued by [C]',
      );
      expect(commanded.commandsInUse).toBe(1);
      expect(commanded.commandsInUse).toBeLessThanOrEqual(commanded.commandCapacity);
    } finally {
      await closeQuietly(page);
      await closeQuietly(context);
    }
  }, 90_000);
});
