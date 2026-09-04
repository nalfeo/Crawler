import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import {
  loadMainSceneProbeLab,
  tapKeyUntil,
  mainSceneProbe,
  waitForState,
} from './helpers/main-scene-probe.js';
import { GAME_H, GAME_W } from './e2e-constants.js';

interface CdpSession {
  send(method: string, params: unknown): Promise<unknown>;
  detach(): Promise<void>;
}

/** Dispatches a single touch tap (touchstart + touchend, no move) via CDP. */
async function tapTouch(page: Page, point: { x: number; y: number }): Promise<void> {
  const context = page.context() as BrowserContext & {
    newCDPSession(page: Page): Promise<CdpSession>;
  };
  const session = await context.newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: point.x, y: point.y, id: 1 }],
    });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await session.detach();
  }
}

async function withHeldTouch(
  page: Page,
  run: (session: CdpSession) => Promise<void>,
): Promise<void> {
  const context = page.context() as BrowserContext & {
    newCDPSession(page: Page): Promise<CdpSession>;
  };
  const session = await context.newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 200, y: 300, id: 1 }],
    });
    await run(session);
  } finally {
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  }
}

/**
 * Poll until the bottom-center interaction hint ("Talk") is visible again and
 * return its current screen-space bounds.
 */
async function waitForInteractionHintBounds(
  page: Page,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const deadline = Date.now() + 8_000;
  for (;;) {
    const bounds = await mainSceneProbe.getInteractionHintBounds(page);
    if (bounds) return bounds;
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the interaction hint to become visible');
    }
    await page.waitForTimeout(100);
  }
}

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
  );
}

describe('MainGameScene UI exclusivity', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  // Dedicated touch-enabled context for the backdrop-tap coverage below —
  // the shared `page` above stays mouse-only so unrelated tests in this file
  // keep exercising `page.mouse.click`.
  let touchContext: BrowserContext;
  let touchPage: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    page = await context.newPage();
    touchContext = await browser.newContext({
      hasTouch: true,
      viewport: { width: 1600, height: 900 },
    });
    touchPage = await touchContext.newPage();
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  async function bootPlayingSafeScene(targetPage: Page = page): Promise<void> {
    await loadMainSceneProbeLab(targetPage);
    await mainSceneProbe.resolveLoadout(targetPage);
    await waitForState(targetPage, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'loadout resolved + simulation paused',
    });
    await mainSceneProbe.unlockSafeRoomSurfaces(targetPage);
    await waitForState(targetPage, (s) => s.safeContext, { label: 'safe-room surfaces unlocked' });
  }

  it('pauses for the issue picker and restores the exact prior pause state', async () => {
    await bootPlayingSafeScene();

    await mainSceneProbe.setSimulationPaused(page, false);
    await waitForState(page, (s) => !s.simulationPaused, {
      label: 'simulation running before report',
    });

    await page.keyboard.press('F8');
    await waitForState(page, (s) => s.issueReportOpen && s.simulationPaused, {
      label: 'issue picker opened with simulation paused',
    });
    await page.keyboard.press('Escape');
    await waitForState(page, (s) => !s.issueReportOpen && !s.simulationPaused, {
      label: 'issue picker restored running simulation',
    });

    await mainSceneProbe.setSimulationPaused(page, true);
    await page.keyboard.press('F8');
    await waitForState(page, (s) => s.issueReportOpen && s.simulationPaused, {
      label: 'issue picker opened from an already paused scene',
    });
    await page.keyboard.press('Escape');
    await waitForState(page, (s) => !s.issueReportOpen && s.simulationPaused, {
      label: 'issue picker preserved pre-existing pause',
    });
  });

  it('keeps the Issue button clickable over inventory without closing the underlying UX', async () => {
    await bootPlayingSafeScene();

    await mainSceneProbe.requestInventoryToggle(page);
    const inventoryState = await waitForState(
      page,
      (s) => s.inventoryOpen && s.issueButtonVisible,
      {
        label: 'inventory opened with Issue button visible',
      },
    );
    expect(
      inventoryState.simulationPaused,
      'safe-room inventory should preserve the paused state',
    ).toBe(true);

    const issueBounds = await mainSceneProbe.getIssueButtonBounds(page);
    expect(issueBounds, 'visible Issue button should expose screen-space bounds').not.toBeNull();
    const canvas = await page.locator('#lab-canvas canvas').boundingBox();
    expect(canvas, 'main-scene probe canvas should exist').not.toBeNull();
    if (!issueBounds || !canvas) return;
    await page.mouse.click(
      canvas.x + (issueBounds.x + issueBounds.width / 2) * (canvas.width / 1280),
      canvas.y + (issueBounds.y + issueBounds.height / 2) * (canvas.height / 720),
    );

    await waitForState(page, (s) => s.issueReportOpen && s.inventoryOpen, {
      label: 'issue picker opened above inventory',
    });

    await page.keyboard.press('Escape');
    const restored = await waitForState(
      page,
      (s) => !s.issueReportOpen && s.inventoryOpen && s.simulationPaused,
      {
        label: 'issue picker closed with inventory and pause state preserved',
      },
    );
    expect(
      restored.issueButtonVisible,
      'Issue button should return after cancelling a report',
    ).toBe(true);
  });

  it('keeps the Issue button clear of the skill HUD on small screens', async () => {
    const smallContext = await browser.newContext({ viewport: { width: 960, height: 540 } });
    const smallPage = await smallContext.newPage();
    try {
      await bootPlayingSafeScene(smallPage);
      const issueBounds = await mainSceneProbe.getIssueButtonBounds(smallPage);
      const skillBounds = (await mainSceneProbe.getSafeAreaLayout(smallPage)).surfaces.find(
        ({ name }) => name === 'skillPanel',
      )?.bounds;

      expect(issueBounds, 'Issue button should remain visible on small screens').not.toBeNull();
      expect(skillBounds, 'skill HUD bounds should be available').toBeDefined();
      if (!issueBounds || !skillBounds) return;
      expect(overlaps(issueBounds, skillBounds), 'Issue button must not cover the skill HUD').toBe(
        false,
      );
    } finally {
      await closeQuietly(smallContext);
    }
  });

  it('anchors the Issue button bottom-right and never overlaps a supported HUD surface', async () => {
    // Floor 2 activates the bottom-right family-relationships panel, so
    // booting there exercises the tightest supported-surface set (#4210).
    const familyContext = await browser.newContext({ viewport: { width: GAME_W, height: GAME_H } });
    const familyPage = await familyContext.newPage();
    try {
      await loadMainSceneProbeLab(familyPage, { floor: 'floor2' });
      await mainSceneProbe.resolveLoadout(familyPage);
      await waitForState(familyPage, (s) => s.worldState === 'playing' && s.simulationPaused, {
        label: 'floor2 loadout resolved + simulation paused',
      });
      await mainSceneProbe.unlockSafeRoomSurfaces(familyPage);
      await waitForState(familyPage, (s) => s.safeContext, {
        label: 'floor2 safe-room surfaces unlocked',
      });

      const assertBottomRightNoOverlap = async (label: string): Promise<void> => {
        const issueBounds = await mainSceneProbe.getIssueButtonBounds(familyPage);
        expect(issueBounds, `Issue button should be visible (${label})`).not.toBeNull();
        if (!issueBounds) return;
        // Bottom-right anchored: right/bottom edges close to the safe rect's
        // right/bottom edges, not parked in the top-right minimap/tracker zone.
        expect(issueBounds.x + issueBounds.width, `right-anchored (${label})`).toBeGreaterThan(
          GAME_W - 220,
        );
        expect(issueBounds.y + issueBounds.height, `bottom-anchored (${label})`).toBeGreaterThan(
          GAME_H - 220,
        );
        expect(issueBounds.y, `not parked at the top (${label})`).toBeGreaterThan(GAME_H / 2);

        const { surfaces } = await mainSceneProbe.getSafeAreaLayout(familyPage);
        for (const surface of surfaces) {
          if (surface.name === 'issueButton') continue;
          expect(
            overlaps(issueBounds, surface.bounds),
            `Issue button must not cover ${surface.name} (${label})`,
          ).toBe(false);
        }
      };

      await assertBottomRightNoOverlap('no panel open');

      await mainSceneProbe.requestInventoryToggle(familyPage);
      await waitForState(familyPage, (s) => s.inventoryOpen && s.issueButtonVisible, {
        label: 'inventory opened with Issue button visible',
      });
      await assertBottomRightNoOverlap('inventory panel open');
    } finally {
      await closeQuietly(familyContext);
    }
  });

  it('gives the issue picker exclusive keyboard ownership over loadout and Skills UX', async () => {
    await loadMainSceneProbeLab(page);
    await waitForState(page, (s) => s.worldState === 'loadout' && s.issueButtonVisible, {
      label: 'starter loadout opened with Issue available',
    });
    await page.keyboard.press('F8');
    await waitForState(page, (s) => s.issueReportOpen, {
      label: 'issue picker opened above starter loadout',
    });
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.keyboard.press('Enter');
    const loadoutState = await waitForState(
      page,
      (s) => s.issueReportOpen && s.worldState === 'loadout',
      {
        label: 'Enter handled only by issue picker',
      },
    );
    expect(loadoutState.modalOpen, 'starter picker should remain open behind Issue').toBe(true);
    await page.keyboard.press('Escape');
    await waitForState(page, (s) => !s.issueReportOpen && s.modalOpen, {
      label: 'starter picker restored after issue cancellation',
    });

    await bootPlayingSafeScene();
    await mainSceneProbe.queueAbilitiesToggle(page);
    await waitForState(page, (s) => s.abilityLoadoutOpen && s.issueButtonVisible, {
      label: 'Skills opened with Issue available',
    });
    await page.keyboard.press('F8');
    await waitForState(page, (s) => s.issueReportOpen && s.abilityLoadoutOpen, {
      label: 'issue picker opened above Skills',
    });
    await page.keyboard.press('Escape');
    await waitForState(page, (s) => !s.issueReportOpen && s.abilityLoadoutOpen, {
      label: 'Escape closed only Issue and preserved Skills',
    });
  });

  it('dismisses the issue picker by tapping its backdrop', async () => {
    await bootPlayingSafeScene(touchPage);

    await mainSceneProbe.setSimulationPaused(touchPage, false);
    await waitForState(touchPage, (s) => !s.simulationPaused, {
      label: 'simulation running before touch report dismissal',
    });
    await touchPage.keyboard.press('F8');
    await waitForState(touchPage, (s) => s.issueReportOpen && s.simulationPaused, {
      label: 'issue picker opened before touch dismissal',
    });

    // The panel itself must not be treated as its backdrop.
    await tapTouch(touchPage, { x: 800, y: 350 });
    await waitForState(touchPage, (s) => s.issueReportOpen && s.simulationPaused, {
      label: 'issue picker stayed open after an in-panel tap',
    });

    // This point is inside the game canvas but outside the centered picker.
    await tapTouch(touchPage, { x: 200, y: 120 });
    await waitForState(touchPage, (s) => !s.issueReportOpen && !s.simulationPaused, {
      label: 'touch backdrop dismissal restored running simulation',
    });
  });

  it('ignores a backdrop tap on a non-cancellable picker', async () => {
    await bootPlayingSafeScene(touchPage);

    await mainSceneProbe.openBossRewardPicker(touchPage);
    await waitForState(touchPage, (s) => s.modalOpen, {
      label: 'non-cancellable spell-reward picker opened',
    });

    // Same outside-the-panel point that dismisses a cancellable picker above.
    await tapTouch(touchPage, { x: 200, y: 120 });
    await waitForState(touchPage, (s) => s.modalOpen, {
      label: 'non-cancellable picker stayed open after a backdrop tap',
    });
  });

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

  it('closes the achievements panel with Escape without opening another surface', async () => {
    await bootPlayingSafeScene();

    await mainSceneProbe.requestAchievementsToggle(page);
    await waitForState(page, (s) => s.achievementsOpen, {
      label: 'achievements panel opened for Escape dismissal',
    });

    await page.keyboard.press('Escape');
    const state = await waitForState(page, (s) => !s.achievementsOpen, {
      label: 'achievements panel closed by Escape',
    });

    expect(
      state.primarySurfaceCount,
      'Escape must not open or expose another primary surface',
    ).toBe(0);
    expect(state.conversationOpen, 'Escape must not leak into NPC interaction').toBe(false);
  });

  it('requires an explicit NPC interaction before dialogue opens', async () => {
    await bootPlayingSafeScene();
    const npcTarget = await mainSceneProbe.primeNpcInteractionTarget(page);
    expect(npcTarget, 'probe should expose at least one NPC interaction target').not.toBeNull();
    await page.waitForFunction(
      () => window.__mainSceneProbe?.getInteractionHintBounds() !== null,
      undefined,
      { timeout: 5_000 },
    );
    const awardsBounds = await mainSceneProbe.getAchievementsButtonBounds(page);
    const talkBounds = await mainSceneProbe.getInteractionHintBounds(page);
    const canvas = await page.locator('#lab-canvas canvas').boundingBox();
    expect(awardsBounds, 'Awards button should expose screen-space bounds').not.toBeNull();
    expect(talkBounds, 'Talk button should expose screen-space bounds').not.toBeNull();
    expect(canvas, 'main-scene probe canvas should exist').not.toBeNull();
    if (!awardsBounds || !talkBounds || !canvas) return;

    const toCanvas = ({ x, y }: { x: number; y: number }) => ({
      x: canvas.x + x * (canvas.width / 1280),
      y: canvas.y + y * (canvas.height / 720),
    });
    const clickDesignPoint = async (point: { x: number; y: number }): Promise<void> => {
      const target = toCanvas(point);
      await page.mouse.click(target.x, target.y);
    };
    await clickDesignPoint({ x: 800, y: 450 });
    await page.waitForTimeout(100);
    expect((await mainSceneProbe.getState(page)).conversationOpen).toBe(false);

    await clickDesignPoint({
      x: awardsBounds.x + awardsBounds.width / 2,
      y: awardsBounds.y + awardsBounds.height / 2,
    });
    await waitForState(page, (state) => state.achievementsOpen && !state.conversationOpen, {
      label: 'Awards opened without NPC dialogue',
    });
    await mainSceneProbe.requestAchievementsToggle(page);
    await waitForState(page, (state) => !state.achievementsOpen, { label: 'Awards closed' });

    const npcScreenPoint = await mainSceneProbe.getPrimedNpcScreenPoint(page);
    expect(npcScreenPoint, 'NPC should expose a screen-space hit point').not.toBeNull();
    if (!npcScreenPoint) return;
    await clickDesignPoint(npcScreenPoint);
    await waitForState(page, (state) => state.conversationOpen, {
      label: 'NPC click opened dialogue',
    });
    await tapKeyUntil(
      page,
      'Escape',
      async () => !(await mainSceneProbe.getState(page)).conversationOpen,
      { label: 'NPC dialogue to close before Talk click' },
    );
    // The hint is hidden for the duration of a conversation and only restored on
    // the next scene update; reading its bounds in the same tick can still come
    // back null, so poll until the button is back before tapping it.
    const restoredTalkBounds = await waitForInteractionHintBounds(page);

    await clickDesignPoint({
      x: restoredTalkBounds.x + restoredTalkBounds.width / 2,
      y: restoredTalkBounds.y + restoredTalkBounds.height / 2,
    });
    await waitForState(page, (state) => state.conversationOpen, {
      label: 'Talk button opened dialogue',
    });
    // Tapped until consumed: the scene samples Escape/E with `JustDown`, and it
    // also drains those keys via `clearPendingInteractionInput()`, so a single
    // press (held or not) can be swallowed and never re-arm.
    await tapKeyUntil(
      page,
      'Escape',
      async () => !(await mainSceneProbe.getState(page)).conversationOpen,
      { label: 'Talk dialogue to close before E interaction' },
    );
    await tapKeyUntil(
      page,
      'e',
      async () => (await mainSceneProbe.getState(page)).conversationOpen,
      { label: 'E to open dialogue' },
    );
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

  it('suppresses held touch input while inventory and equipment surfaces transition', async () => {
    for (const surface of [
      {
        label: 'inventory',
        isOpen: (state: Awaited<ReturnType<typeof mainSceneProbe.getState>>) => state.inventoryOpen,
        toggle: mainSceneProbe.requestInventoryToggle,
      },
      {
        label: 'equipment',
        isOpen: (state: Awaited<ReturnType<typeof mainSceneProbe.getState>>) => state.equipmentOpen,
        toggle: mainSceneProbe.requestEquipToggle,
      },
    ]) {
      await bootPlayingSafeScene(touchPage);
      await mainSceneProbe.setSimulationPaused(touchPage, false);
      const npcTarget = await mainSceneProbe.primeNpcInteractionTarget(touchPage);
      expect(npcTarget, 'probe should expose an NPC interaction target').not.toBeNull();

      await surface.toggle(touchPage);
      const opened = await waitForState(touchPage, surface.isOpen, {
        label: `${surface.label} opened before held-touch check`,
      });
      expect(opened.conversationOpen).toBe(false);

      await withHeldTouch(touchPage, async (session) => {
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: 800, y: 700, id: 1 }],
        });
        await touchPage.waitForTimeout(100);
        const whileOpen = await mainSceneProbe.getState(touchPage);

        expect(whileOpen.playerFeet).toEqual(opened.playerFeet);
        expect(whileOpen.conversationOpen).toBe(false);

        await surface.toggle(touchPage);
        await waitForState(touchPage, (state) => !surface.isOpen(state), {
          label: `${surface.label} closed while touch remains held`,
        });
        await touchPage.waitForTimeout(100);
      });

      const afterClose = await mainSceneProbe.getState(touchPage);
      expect(afterClose.playerFeet).toEqual(opened.playerFeet);
      expect(afterClose.conversationOpen).toBe(false);
    }
  });

  it('clears held touch input after dialogue closes', async () => {
    await bootPlayingSafeScene(touchPage);
    await mainSceneProbe.setSimulationPaused(touchPage, false);
    const npcTarget = await mainSceneProbe.primeNpcInteractionTarget(touchPage);
    expect(npcTarget, 'probe should expose an NPC interaction target').not.toBeNull();

    await mainSceneProbe.queueInteraction(touchPage);
    const opened = await waitForState(touchPage, (state) => state.conversationOpen, {
      label: 'dialogue opened before held-touch close check',
    });

    await withHeldTouch(touchPage, async (session) => {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: 800, y: 700, id: 1 }],
      });
      for (let line = 0; line < 4; line += 1) {
        await mainSceneProbe.queueInteraction(touchPage);
        await touchPage.waitForTimeout(100);
        if (!(await mainSceneProbe.getState(touchPage)).conversationOpen) {
          break;
        }
      }
      await waitForState(touchPage, (state) => !state.conversationOpen, {
        label: 'dialogue closed while touch remains held',
      });
      await touchPage.waitForTimeout(100);
    });

    const afterClose = await mainSceneProbe.getState(touchPage);
    expect(afterClose.playerFeet).toEqual(opened.playerFeet);
    expect(afterClose.conversationOpen).toBe(false);
  });

  it('suppresses held touch input while the quartermaster surface closes', async () => {
    await loadMainSceneProbeLab(touchPage, { floor: 'floor2' });
    await mainSceneProbe.resolveLoadout(touchPage);
    await mainSceneProbe.unlockSafeRoomSurfaces(touchPage);
    await mainSceneProbe.setSimulationPaused(touchPage, false);
    const quartermaster = (await mainSceneProbe.getNpcRenderInfo(touchPage)).find(
      (npc) => npc.defId === 'shop-the-quartermaster',
    );
    expect(quartermaster, 'Floor 2 should expose a quartermaster NPC').toBeDefined();

    await mainSceneProbe.setPlayerFeet(touchPage, quartermaster!.feet.x, quartermaster!.feet.y);
    await mainSceneProbe.advanceSimulationFrames(touchPage, 1);
    await mainSceneProbe.queueInteraction(touchPage);
    const opened = await waitForState(touchPage, (state) => state.quartermasterOpen, {
      label: 'quartermaster panel opened before held-touch check',
    });

    await withHeldTouch(touchPage, async (session) => {
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: 800, y: 700, id: 1 }],
      });
      await touchPage.waitForTimeout(100);
      await mainSceneProbe.requestQuartermasterToggle(touchPage);
      await waitForState(touchPage, (state) => !state.quartermasterOpen, {
        label: 'quartermaster panel closed while touch remains held',
      });
      await touchPage.waitForTimeout(100);
    });

    const afterClose = await mainSceneProbe.getState(touchPage);
    expect(afterClose.playerFeet).toEqual(opened.playerFeet);
    expect(afterClose.conversationOpen).toBe(false);
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

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 960, height: 540 },
  ] as const) {
    it(`keeps spell stats separated from abilities descriptions at ${viewport.width}x${viewport.height}`, async () => {
      const abilityContext = await browser.newContext({ viewport });
      const abilityPage = await abilityContext.newPage();
      try {
        await bootPlayingSafeScene(abilityPage);

        await mainSceneProbe.queueAbilitiesToggle(abilityPage);
        const state = await waitForState(
          abilityPage,
          (s) =>
            s.abilityLoadoutOpen &&
            s.abilityLoadoutVisibleEntries.some((entry) => entry.id === 'fireball') &&
            s.abilityLoadoutRowLayouts.some((layout) => layout.id === 'fireball'),
          {
            label: `abilities loadout opened with fireball at ${viewport.width}x${viewport.height}`,
          },
        );

        const fireball = state.abilityLoadoutVisibleEntries.find(
          (entry) => entry.id === 'fireball',
        );
        expect(fireball?.details).not.toContain('Damage 15');
        expect(fireball?.description).toContain('Damage 15');
        expect(fireball?.description).toContain('Target & blast radius 12 ft');

        const layout = state.abilityLoadoutRowLayouts.find((layout) => layout.id === 'fireball');
        expect(layout, 'fireball row layout should be measured').toBeDefined();
        expect(
          overlaps(layout!.details, layout!.description),
          `fireball details must not overlap description at ${viewport.width}x${viewport.height}`,
        ).toBe(false);

        // The stat line pushes the description down, so a row sized to a fixed
        // height renders its description past the row edge and over the row
        // below. Assert containment on every visible row, not just fireball.
        for (const rowLayout of state.abilityLoadoutRowLayouts) {
          const rowBottom = rowLayout.row.y + rowLayout.row.height;
          expect(
            rowLayout.details.y + rowLayout.details.height,
            `${rowLayout.id} stat line overflows its row at ${viewport.width}x${viewport.height}`,
          ).toBeLessThanOrEqual(rowBottom);
          expect(
            rowLayout.description.y + rowLayout.description.height,
            `${rowLayout.id} description overflows its row at ${viewport.width}x${viewport.height}`,
          ).toBeLessThanOrEqual(rowBottom);
        }

        // Growing a row must push later rows down rather than draw over them.
        const rows = state.abilityLoadoutRowLayouts;
        for (let i = 1; i < rows.length; i += 1) {
          expect(
            overlaps(rows[i - 1]!.row, rows[i]!.row),
            `${rows[i - 1]!.id} and ${rows[i]!.id} rows must not overlap at ${viewport.width}x${viewport.height}`,
          ).toBe(false);
        }
      } finally {
        await abilityContext.close();
      }
    });
  }

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

  it('renders the Bow level-5 reward name and effect in the real HUD announcement', async () => {
    await bootPlayingSafeScene();
    await mainSceneProbe.queueSkillUsage(page, 'bow', 'weapon_fired', 135);
    await mainSceneProbe.advanceSimulationFrames(page, 2);

    const announcementState = await waitForState(
      page,
      (s) =>
        s.currentAnnouncement?.kind === 'skillPassiveUnlocked' &&
        s.currentAnnouncement.text.includes('Steady Aim'),
      { label: 'Bow level-5 milestone renders its player-facing reward' },
    );

    expect(announcementState.currentAnnouncement?.text).toContain('Steady Aim');
    expect(announcementState.currentAnnouncement?.text).toContain('+0.1 accuracy with bows');
    expect(announcementState.currentAnnouncement?.text).not.toContain('bow-shot-base');
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

  it('hides the Gear shortcut and refuses [G] while the Gear panel reveal is still locked', async () => {
    // Issue #3310: Gear must stay hidden on Floor 1 until the merchant's charm
    // is in hand, even though the equipment *capability* latch is already set
    // by the starter weapon the player spawns holding.
    await bootPlayingSafeScene();
    await mainSceneProbe.setEquipmentPanelUnlocked(page, false);
    await waitForState(page, (s) => !s.equipButtonVisible, { label: 'gear shortcut hidden' });

    await mainSceneProbe.requestEquipToggle(page);
    await page.waitForTimeout(250);

    const locked = await mainSceneProbe.getState(page);
    expect(locked.equipButtonVisible, 'Gear shortcut must stay hidden pre-charm').toBe(false);
    expect(locked.equipmentOpen, '[G] must not open Gear pre-charm').toBe(false);
    expect(locked.inventoryButtonVisible, 'the Bag shortcut is a separate unlock').toBe(true);

    // Acquiring the charm reveals it, and [G] works again.
    await mainSceneProbe.setEquipmentPanelUnlocked(page, true);
    await waitForState(page, (s) => s.equipButtonVisible, { label: 'gear shortcut revealed' });
    await mainSceneProbe.requestEquipToggle(page);
    await waitForState(page, (s) => s.equipmentOpen, { label: 'gear panel opened after charm' });
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
