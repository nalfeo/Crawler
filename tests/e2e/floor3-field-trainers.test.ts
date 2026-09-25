import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

describe('Floor 3 field Trainers in the rendered production scene', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('renders the circuit, stays idle away from it, then starts an automatic roster battle by movement', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await loadMainSceneProbeLab(page, { floor: 'floor3' });
      await waitForState(page, (state) => state.worldState === 'loadout');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => window.__mainSceneProbe?.getModalPickerContent()?.kind === 'floor3-starter',
      );
      await page.keyboard.press('Enter');
      await waitForState(page, (state) => state.worldState === 'playing');
      // The existing first-Studio versus card is presentation-only, but its
      // modal pauses the scene's fixed-step loop until acknowledged.
      await page.waitForFunction(
        () => window.__mainSceneProbe?.getModalPickerContent()?.kind === 'floor3-studio-versus',
      );
      await page.keyboard.press('Enter');
      await mainSceneProbe.setSimulationPaused(page, true);

      const before = await mainSceneProbe.getFloor3FieldTrainers(page);
      expect(before.map((trainer) => trainer.name)).toEqual(['Mara', 'Oren', 'Sable']);
      expect(before.every((trainer) => trainer.npcVisible)).toBe(true);
      expect(before.every((trainer) => !trainer.started && trainer.rosterCount === 0)).toBe(true);

      expect(await mainSceneProbe.moveToFloor3FieldTrainer(page, 0)).toBe(true);
      await mainSceneProbe.advanceSimulationFrames(page, 2);
      const after = await mainSceneProbe.getFloor3FieldTrainers(page);
      expect(after[0]!.started).toBe(true);
      expect(after[0]!.rosterCount).toBeGreaterThan(0);
      expect(after[1]!.started).toBe(false);
      await page.screenshot({ path: 'files/floor3-field-trainers.png' });
    } finally {
      await page.close();
    }
  });
});
