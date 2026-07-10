import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

describe('MainGameScene UI exclusivity', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  async function bootPlayingSafeScene(): Promise<void> {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'loadout resolved + simulation paused',
    });
    await mainSceneProbe.unlockSafeRoomSurfaces(page);
    await waitForState(page, (s) => s.safeContext, { label: 'safe-room surfaces unlocked' });
  }

  it('keeps achievements closed when abilities and achievements are queued in the same frame', async () => {
    await bootPlayingSafeScene();

    await mainSceneProbe.queueAbilitiesAndAchievementsToggle(page);
    const state = await waitForState(page, (s) => s.modalOpen, {
      label: 'abilities modal opened',
    });

    expect(state.modalOpen, 'abilities should open the modal picker').toBe(true);
    expect(state.achievementsOpen, 'achievements must stay closed under same-frame B+V').toBe(
      false,
    );
    expect(state.inventoryOpen, 'inventory must stay closed').toBe(false);
    expect(state.equipmentOpen, 'equipment must stay closed').toBe(false);
    expect(state.primarySurfaceCount, 'only one primary surface may remain open').toBe(1);
  });

  it('does not open NPC dialogue behind the achievements panel from a queued interaction', async () => {
    await bootPlayingSafeScene();

    const npcTarget = await mainSceneProbe.primeNpcInteractionTarget(page);
    expect(npcTarget, 'probe should expose at least one NPC interaction target').not.toBeNull();

    await mainSceneProbe.requestAchievementsToggle(page);
    await waitForState(page, (s) => s.achievementsOpen && s.primarySurfaceCount === 1, {
      label: 'achievements panel opened',
    });

    await mainSceneProbe.queueInteraction(page);
    await page.waitForTimeout(250);
    const state = await mainSceneProbe.getState(page);

    expect(state.achievementsOpen, 'achievements should remain open').toBe(true);
    expect(
      state.conversationOpen,
      'queued interaction must not start NPC dialogue while a character panel is open',
    ).toBe(false);
    expect(state.primarySurfaceCount, 'only the achievements surface should remain open').toBe(1);
  });

  it('blocks character-surface toggles and hides corner shortcuts while NPC dialogue is open', async () => {
    await bootPlayingSafeScene();

    const npcTarget = await mainSceneProbe.primeNpcInteractionTarget(page);
    expect(npcTarget, 'probe should expose at least one NPC interaction target').not.toBeNull();

    await mainSceneProbe.queueInteraction(page);
    await waitForState(page, (s) => s.conversationOpen, { label: 'npc dialogue opened' });

    await mainSceneProbe.requestInventoryToggle(page);
    await mainSceneProbe.requestEquipToggle(page);
    await mainSceneProbe.requestAchievementsToggle(page);
    await mainSceneProbe.queueAbilitiesToggle(page);
    await page.waitForTimeout(250);

    const state = await mainSceneProbe.getState(page);
    expect(state.conversationOpen, 'conversation should still be active').toBe(true);
    expect(state.inventoryOpen, 'inventory must stay closed during conversation').toBe(false);
    expect(state.equipmentOpen, 'equipment must stay closed during conversation').toBe(false);
    expect(state.achievementsOpen, 'achievements must stay closed during conversation').toBe(false);
    expect(state.modalOpen, 'abilities modal must stay closed during conversation').toBe(false);
    expect(
      state.inventoryButtonVisible,
      'inventory shortcut should hide while a blocking conversation is open',
    ).toBe(false);
    expect(
      state.equipButtonVisible,
      'equipment shortcut should hide while a blocking conversation is open',
    ).toBe(false);
    expect(
      state.achievementsButtonVisible,
      'achievements shortcut should hide while a blocking conversation is open',
    ).toBe(false);
    expect(state.primarySurfaceCount, 'no character surfaces may open during conversation').toBe(0);
  });
});
