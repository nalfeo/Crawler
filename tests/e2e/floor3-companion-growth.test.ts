import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

describe('Floor 3 evolution in the rendered production scene', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('grows living stats and the real sprite and automatically uses the adult ability', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await loadMainSceneProbeLab(page, { floor: 'floor3' });
      await waitForState(page, (s) => s.worldState === 'loadout');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => window.__mainSceneProbe?.getModalPickerContent()?.kind === 'floor3-starter',
      );
      await page.keyboard.press('Enter');
      await waitForState(page, (s) => s.worldState === 'playing');
      await mainSceneProbe.setSimulationPaused(page, false);
      await page.waitForFunction(
        () => window.__mainSceneProbe?.getModalPickerContent()?.kind === 'floor3-studio-versus',
      );
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => window.__mainSceneProbe?.getFloor3PartyHudState().hudVisible,
      );

      const eid = await page.evaluate(() => window.__mainSceneProbe!.primeFloor3GrowthProbe());
      expect(eid).not.toBeNull();
      await page.waitForFunction(
        (id) => window.__mainSceneProbe?.getFloor3GrowthProbe(id!)?.renderScale !== null,
        eid,
      );
      const read = () =>
        page.evaluate((id) => window.__mainSceneProbe!.getFloor3GrowthProbe(id!), eid);
      const before = (await read())!;
      expect(before.form).toBe(1);
      expect(before.maxHp).toBe(160);
      expect(before.currentHp).toBe(80);
      expect(before.learnedAbilities).toHaveLength(3);
      expect(before.renderScale).toBeGreaterThan(0);
      await mkdir('files/floor3-growth', { recursive: true });
      await page.screenshot({ path: 'files/floor3-growth/before.png' });

      // Advance the scene's real fixed-step loop, never call a combat or growth system.
      let after = before;
      for (let i = 0; i < 20 && after.form !== 2; i += 1) {
        const frame = (await mainSceneProbe.getState(page)).frameCount!;
        await mainSceneProbe.advanceSimulationFrames(page, 10);
        await waitForState(page, (s) => s.frameCount! >= frame + 10);
        after = (await read())!;
      }
      expect(after.form).toBe(2);
      expect(after.maxHp).toBeCloseTo(240);
      expect(after.currentHp).toBeCloseTo(120);
      expect(after.speed / before.speed).toBeCloseTo(Math.sqrt(1.5));
      expect(after.range / before.range).toBeCloseTo(Math.sqrt(1.5));
      expect(after.sizeScale / before.sizeScale).toBeCloseTo(Math.sqrt(1.5));
      expect(after.learnedAbilities).toContain('f3.ember-slinger.l25');
      await page.waitForFunction(
        ({ id, scale }) => {
          const current = window.__mainSceneProbe?.getFloor3GrowthProbe(id!);
          return current?.renderScale !== null && current!.renderScale! > scale! * 1.1;
        },
        { id: eid, scale: before.renderScale },
      );
      await page.screenshot({ path: 'files/floor3-growth/after.png' });

      let adultAttackObserved = false;
      for (let i = 0; i < 40 && !adultAttackObserved; i += 1) {
        const frame = (await mainSceneProbe.getState(page)).frameCount!;
        await mainSceneProbe.advanceSimulationFrames(page, 10);
        await waitForState(page, (s) => s.frameCount! >= frame + 10);
        adultAttackObserved = (await read())?.lastAbilityId === 'f3.ember-slinger.l25';
      }
      expect(adultAttackObserved).toBe(true);
    } finally {
      await page.close();
    }
  });
});
