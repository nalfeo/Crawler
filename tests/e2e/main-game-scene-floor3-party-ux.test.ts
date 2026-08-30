/**
 * Real-artifact guard for the Floor-3 party-combat UX surfaces (game-design
 * §15 surfaces 4–8).
 *
 * The per-surface lab (`tests/e2e/floor3-party-hud.deterministic.test.ts`)
 * proves the widgets render and respond; a lab can never prove the *shipped*
 * scene mounts them or binds their keys (AGENTS.md rule #9). This suite boots
 * the real `MainGameScene` on Floor 3 through the shipped floor bootstrap
 * (`main-scene-probe-lab`), resolves the real rules briefing and
 * starter-Companion loadout, then drives the real `[R]` / `[C]` key bindings,
 * asserting the mounted HUD and roster overlay respond.
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

async function waitForModalKind(page: Page, kind: string, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const content = await mainSceneProbe.getModalPickerContent(page);
    if (content?.kind === kind) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; last content: ${JSON.stringify(content)}`);
    }
    await page.waitForTimeout(80);
  }
}

async function waitForModalTitle(page: Page, title: string, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const content = await mainSceneProbe.getModalPickerContent(page);
    if (content?.title === title) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}; last content: ${JSON.stringify(content)}`);
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

      // Resolve the real Floor 3 intro, then the starter picker through the shipped modals.
      await page.keyboard.press('Enter');
      await waitForModalTitle(
        page,
        'Choose your starter Companion',
        'Floor 3 starter-companion modal after intro',
      );

      await page.keyboard.press('Enter');
      await waitForState(page, (s) => s.floorId === 'floor3' && s.worldState === 'playing', {
        timeoutMs: 10_000,
        label: 'Floor 3 loadout confirmed',
      });
      await mainSceneProbe.setSimulationPaused(page, false);

      // The first unlocked Studio announces itself with a blocking versus card
      // (UX surface #10), which hides the HUD until it is acknowledged.
      await waitForModalKind(page, 'floor3-studio-versus', 'Floor 3 Studio versus card');
      await page.keyboard.press('Enter');

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

      await waitForState(page, (s) => s.floor3RosterButtonVisible && s.floor3CommandButtonVisible, {
        timeoutMs: 10_000,
        label: 'Floor 3 touch buttons visible',
      });

      // The on-canvas roster button opens the real roster overlay with a live detail column.
      expect(await mainSceneProbe.tapFloor3RosterButton(page)).toBe(true);
      const rosterOpen = await waitForPartyHud(
        page,
        (s) => s.rosterOpen,
        'Floor 3 roster overlay opened by touch button',
      );
      expect(rosterOpen.rosterEntries.length).toBe(docked.rowNames.length);
      expect(rosterOpen.rosterCursor).toBe(0);
      expect(rosterOpen.rosterDetailLineCount).toBeGreaterThan(0);

      const elapsedWhileOpen = await mainSceneProbe.getWorldElapsedMs(page);
      await page.waitForTimeout(250);
      expect(await mainSceneProbe.getWorldElapsedMs(page)).toBe(elapsedWhileOpen);

      // Escape closes it through the scene's blocking-surface handling.
      await page.keyboard.press('Escape');
      await waitForPartyHud(
        page,
        (s) => !s.rosterOpen,
        'Floor 3 roster overlay closed by [Escape]',
      );

      // The on-canvas command button spends a command charge on the mounted HUD.
      expect(await mainSceneProbe.tapFloor3CommandButton(page)).toBe(true);
      const commanded = await waitForPartyHud(
        page,
        (s) => s.commandsInUse > 0,
        'Floor 3 companion command issued by touch button',
      );
      expect(commanded.commandsInUse).toBe(1);
      expect(commanded.commandsInUse).toBeLessThanOrEqual(commanded.commandCapacity);

      await page.waitForTimeout(250);
      const elapsedAfterRosterClosed = await mainSceneProbe.getWorldElapsedMs(page);
      expect(elapsedAfterRosterClosed).not.toBe(elapsedWhileOpen);

      await page.keyboard.press('r');
      await waitForPartyHud(page, (s) => s.rosterOpen, 'Floor 3 roster overlay opened by [R]');
      await page.keyboard.press('Escape');
      await waitForPartyHud(page, (s) => !s.rosterOpen, 'Floor 3 roster overlay closed again');
    } finally {
      await closeQuietly(page);
      await closeQuietly(context);
    }
  }, 90_000);
});
