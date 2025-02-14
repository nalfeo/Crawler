import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { FLOOR2_QUARTERMASTER_ARCHETYPE_ID } from '../../src/shared/data/shop-archetypes.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('MainGameScene Floor 2 Quartermaster placement', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    await loadMainSceneProbeLab(page, { floor: 'floor2' });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('exposes exactly one Quartermaster plus 1-2 other shops through the real scene bootstrap', async () => {
    const state = await mainSceneProbe.getState(page);
    const quartermasters = state.settlementShopArchetypeIds.filter(
      (archetypeId) => archetypeId === FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
    );
    const otherShops = state.settlementShopArchetypeIds.filter(
      (archetypeId) => archetypeId !== FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
    );

    expect(state.settlementRoomCount).toBeGreaterThanOrEqual(2);
    expect(state.settlementRoomCount).toBeLessThanOrEqual(3);
    expect(quartermasters).toHaveLength(1);
    expect(otherShops.length).toBeGreaterThanOrEqual(1);
    expect(otherShops.length).toBeLessThanOrEqual(2);
  });
});
