import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';
import { closeQuietly } from './helpers/ui-probe.js';

describe('Floor 1 quota completion handoff', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('opens one blocking return-to-broker modal, resumes, and does not repeat', async () => {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.primeFloor1QuotaCompletion(page);
    await waitForState(page, (state) => state.modalOpen, {
      label: 'Floor 1 quota completion modal',
    });

    const modal = await mainSceneProbe.getModalPickerContent(page);
    expect(modal?.kind).toBe('floor1-quest-completed');
    expect(modal?.title).toBe('First leg complete');
    expect(modal?.body).toContain('Return to the Broker for your next quests.');

    const paused = await mainSceneProbe.getState(page);
    expect(paused.simulationPaused).toBe(true);
    const pausedFrame = paused.frameCount;
    await page.waitForTimeout(300);
    expect((await mainSceneProbe.getState(page)).frameCount).toBe(pausedFrame);

    await page.keyboard.press('Enter');
    await waitForState(page, (state) => !state.modalOpen && !state.simulationPaused, {
      label: 'quota completion modal acknowledgement',
    });
    await mainSceneProbe.advanceSimulationFrames(page, 8);
    expect(await mainSceneProbe.getModalPickerContent(page)).toBeNull();
  });
});
