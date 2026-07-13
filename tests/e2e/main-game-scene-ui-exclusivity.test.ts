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
    const state = await waitForState(page, (s) => s.abilityLoadoutOpen, {
      label: 'abilities loadout opened',
    });

    expect(state.abilityLoadoutOpen, 'abilities should open the dedicated loadout').toBe(true);
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

  it('does not leak keyboard or pointer interactions through the abilities loadout', async () => {
    for (const interaction of ['keyboard', 'pointer'] as const) {
      await bootPlayingSafeScene();
      const npcTarget = await mainSceneProbe.primeNpcInteractionTarget(page);
      expect(npcTarget, 'probe should expose at least one NPC interaction target').not.toBeNull();

      await mainSceneProbe.queueAbilitiesToggle(page);
      await waitForState(page, (s) => s.abilityLoadoutOpen, {
        label: `abilities loadout opened for ${interaction} input`,
      });

      if (interaction === 'keyboard') {
        await page.keyboard.down('e');
      } else {
        await page.mouse.click(800, 450);
      }
      await page.keyboard.press('b');
      await waitForState(page, (s) => !s.abilityLoadoutOpen, {
        label: `abilities loadout closed after ${interaction} input`,
      });
      if (interaction === 'keyboard') {
        await page.keyboard.up('e');
      }
      await page.waitForTimeout(250);

      const state = await mainSceneProbe.getState(page);
      expect(
        state.conversationOpen,
        `${interaction} input inside the abilities loadout must not start NPC dialogue after close`,
      ).toBe(false);
    }
  });

  it('does not open inventory after pressing I inside the abilities loadout', async () => {
    await bootPlayingSafeScene();

    await mainSceneProbe.queueAbilitiesToggle(page);
    await waitForState(page, (s) => s.abilityLoadoutOpen, {
      label: 'abilities loadout opened for inventory latch check',
    });

    await page.keyboard.press('i');
    await page.keyboard.press('b');
    await waitForState(page, (s) => !s.abilityLoadoutOpen, {
      label: 'abilities loadout closed after inventory latch check',
    });
    await page.waitForTimeout(250);

    const state = await mainSceneProbe.getState(page);
    expect(
      state.inventoryOpen,
      'I pressed inside the abilities loadout must not open inventory',
    ).toBe(false);
    expect(state.equipmentOpen, 'equipment must stay closed').toBe(false);
    expect(state.achievementsOpen, 'achievements must stay closed').toBe(false);
    expect(state.primarySurfaceCount, 'no character surface should open after close').toBe(0);
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
    expect(state.abilityLoadoutOpen, 'abilities loadout must stay closed during conversation').toBe(
      false,
    );
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

  it('still allows interaction input to advance or close active dialogue', async () => {
    await bootPlayingSafeScene();

    const npcTarget = await mainSceneProbe.primeNpcInteractionTarget(page);
    expect(npcTarget, 'probe should expose at least one NPC interaction target').not.toBeNull();

    await mainSceneProbe.queueInteraction(page);
    const before = await waitForState(page, (s) => s.conversationOpen, {
      label: 'npc dialogue opened',
    });

    await mainSceneProbe.queueInteraction(page);
    await page.waitForTimeout(150);
    const after = await mainSceneProbe.getState(page);

    expect(
      !after.conversationOpen ||
        (after.conversationLineIndex ?? -1) > (before.conversationLineIndex ?? -1),
      'interaction input should advance to the next line or close the conversation',
    ).toBe(true);
  });
});
