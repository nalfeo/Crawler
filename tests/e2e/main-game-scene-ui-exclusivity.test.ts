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

  it('keeps the Skills dismiss shortcut visible above the abilities loadout and closes on tap', async () => {
    await bootPlayingSafeScene();

    const opened = await (async () => {
      await mainSceneProbe.queueAbilitiesToggle(page);
      return waitForState(page, (s) => s.abilityLoadoutOpen && s.abilitiesButtonVisible, {
        label: 'abilities loadout opened with visible Skills dismiss shortcut',
      });
    })();

    expect(opened.abilityLoadoutOpen, 'abilities loadout should be open').toBe(true);
    expect(
      opened.abilitiesButtonVisible,
      'Skills dismiss shortcut should remain visible above the loadout',
    ).toBe(true);

    const tapped = await mainSceneProbe.tapAbilitiesButton(page);
    expect(tapped, 'probe should be able to tap the visible Skills dismiss shortcut').toBe(true);
    await waitForState(page, (s) => !s.abilityLoadoutOpen, {
      label: 'abilities loadout closed from Skills dismiss shortcut tap',
    });
  });

  it('opens the abilities loadout from safe_room world state', async () => {
    await bootPlayingSafeScene();

    await mainSceneProbe.setSafeContext(page, false);
    await mainSceneProbe.setWorldState(page, 'safe_room');
    await waitForState(page, (s) => s.worldState === 'safe_room' && s.safeContext, {
      label: 'safe_room world state activated',
    });

    await mainSceneProbe.queueAbilitiesToggle(page);
    const state = await waitForState(page, (s) => s.abilityLoadoutOpen, {
      label: 'abilities loadout opened from safe_room world state',
    });

    expect(state.worldState, 'probe should be exercising the post-floor safe_room state').toBe(
      'safe_room',
    );
    expect(state.safeContext, 'safe_room should count as a safe context on its own').toBe(true);
    expect(
      state.abilityLoadoutOpen,
      'Skills should open from the post-floor safe_room state even without playerInSafeRoom',
    ).toBe(true);
  });

  it('renders level-5 passive abilities in the loadout projection with active/inactive status', async () => {
    await bootPlayingSafeScene();
    await mainSceneProbe.queueSkillUsage(page, 'swordsmanship', 'hits_landed', 260);
    await mainSceneProbe.queueSkillUsage(page, 'dagger', 'weapon_fired', 160);
    await mainSceneProbe.advanceSimulationFrames(page, 2);

    // Real rendered player-visible projection of the level-5 skill-passive
    // unlock. Poll rather than sample a single frame: the banner is a shared
    // FIFO with other announcement kinds, so the unlock event may not be the
    // very first one drained even though it is guaranteed to appear.
    const announcementState = await waitForState(
      page,
      (s) => s.currentAnnouncement?.kind === 'skillPassiveUnlocked',
      { label: 'level-5 swordsmanship milestone renders a HUD unlock announcement' },
    );
    expect(announcementState.currentAnnouncement?.kind).toBe('skillPassiveUnlocked');
    expect(announcementState.currentAnnouncement?.text).toContain('Combat Flow');

    await mainSceneProbe.setWorldState(page, 'safe_room');
    await waitForState(page, (s) => s.worldState === 'safe_room' && s.safeContext, {
      label: 'safe_room restored for passive projection check',
    });

    await mainSceneProbe.queueAbilitiesToggle(page);
    const state = await waitForState(page, (s) => s.abilityLoadoutOpen, {
      label: 'abilities loadout opened for passive projection check',
    });
    const equippedBeforePassiveActivate = [...state.equippedActiveAbilityIds];

    const combatFlow = state.abilityLoadoutVisibleEntries.find(
      (entry) => entry.id === 'combat-flow',
    );
    expect(combatFlow, 'combat-flow should be visible in the rendered loadout list').toBeDefined();
    expect(combatFlow?.details).toContain('PASSIVE');
    expect(combatFlow?.details).toContain('• ACTIVE •');
    expect(combatFlow?.details).not.toContain('INACTIVE');
    expect(combatFlow?.details).toContain('Damage +5%');

    const daggerRapidStrike = state.abilityLoadoutVisibleEntries.find(
      (entry) => entry.id === 'dagger-rapid-strike-base',
    );
    expect(
      daggerRapidStrike,
      'dagger-rapid-strike-base should be visible in the rendered loadout list',
    ).toBeDefined();
    expect(daggerRapidStrike?.details).toContain('PASSIVE');

    const combatFlowIndex = state.abilityLoadoutVisibleEntries.findIndex(
      (entry) => entry.id === 'combat-flow',
    );
    expect(
      combatFlowIndex,
      'combat-flow should stay inside the visible viewport rows',
    ).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < combatFlowIndex; i += 1) {
      await page.keyboard.press('ArrowDown');
    }

    // Real rendered projection of the distinct non-equippable-passives
    // section header — asserted while the passive row is the active
    // selection so the header is guaranteed to be within the visible window.
    const stateWithHeader = await mainSceneProbe.getState(page);
    expect(
      stateWithHeader.abilityLoadoutSectionHeaderLabel,
      'a distinct PASSIVE section header must render above the non-equippable rows',
    ).toBe('PASSIVE ABILITIES');

    await page.keyboard.press('Enter');

    const afterPassiveActivate = await mainSceneProbe.getState(page);
    expect(
      afterPassiveActivate.equippedActiveAbilityIds,
      'pressing Enter on a passive row must not change the equipped auto-bar loadout',
    ).toEqual(equippedBeforePassiveActivate);
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

  it('does not move after closing the abilities loadout with S held', async () => {
    await bootPlayingSafeScene();

    await mainSceneProbe.queueAbilitiesToggle(page);
    await waitForState(page, (s) => s.abilityLoadoutOpen, {
      label: 'abilities loadout opened for held movement check',
    });

    await page.keyboard.down('s');
    try {
      await page.keyboard.press('b');
      const closed = await waitForState(page, (s) => !s.abilityLoadoutOpen, {
        label: 'abilities loadout closed with S held',
      });
      await mainSceneProbe.setSimulationPaused(page, false);
      await waitForState(page, (s) => !s.simulationPaused, {
        label: 'simulation resumed after held movement close',
      });
      await page.waitForTimeout(250);
      const after = await mainSceneProbe.getState(page);

      if (!closed.playerFeet || !after.playerFeet) {
        throw new Error('player position must remain available during the held movement check');
      }
      expect(after.playerFeet.x).toBeCloseTo(closed.playerFeet.x, 3);
      expect(after.playerFeet.y).toBeCloseTo(closed.playerFeet.y, 3);
    } finally {
      await page.keyboard.up('s');
    }
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
