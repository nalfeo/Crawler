import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 960, height: 540 },
] as const;

type Bounds = { x: number; y: number; width: number; height: number };

// Sub-pixel tolerance: measured Phaser bounds accumulate float error, so boxes
// that are laid out flush against each other must not read as overlapping.
const OVERLAP_EPSILON = 0.5;

function overlaps(a: Bounds, b: Bounds): boolean {
  return (
    a.x < b.x + b.width - OVERLAP_EPSILON &&
    a.x + a.width - OVERLAP_EPSILON > b.x &&
    a.y < b.y + b.height - OVERLAP_EPSILON &&
    a.y + a.height - OVERLAP_EPSILON > b.y
  );
}

describe('real boss reward ability picker UX', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await closeQuietly(browser);
  });

  for (const viewport of VIEWPORTS) {
    it(`fits measured content without overlap at ${viewport.width}x${viewport.height}`, async () => {
      context = await browser.newContext({ viewport });
      page = await context.newPage();
      try {
        await loadMainSceneProbeLab(page);
        await mainSceneProbe.openBossRewardPicker(page);
        const snapshot = await mainSceneProbe.getModalPickerLayout(page);
        if (!snapshot) {
          throw new Error('real boss reward picker layout was unavailable');
        }

        const panelRight = snapshot.panel.x + snapshot.panel.width;
        const panelBottom = snapshot.panel.y + snapshot.panel.height;
        const allContent = [
          snapshot.title,
          snapshot.titleRule,
          snapshot.subtitle,
          snapshot.body,
          ...snapshot.rows.flatMap((row) => [row.row, row.label, row.description]),
          snapshot.footer,
        ].filter((box): box is NonNullable<typeof box> => box !== null);

        for (const box of allContent) {
          expect(box.x).toBeGreaterThanOrEqual(snapshot.panel.x);
          expect(box.y).toBeGreaterThanOrEqual(snapshot.panel.y);
          expect(box.x + box.width).toBeLessThanOrEqual(panelRight);
          expect(box.y + box.height).toBeLessThanOrEqual(panelBottom);
        }
        const topLevel = [
          snapshot.title,
          snapshot.titleRule,
          snapshot.subtitle,
          snapshot.body,
          ...snapshot.rows.map((row) => row.row),
          snapshot.footer,
        ].filter((box): box is Bounds => box !== null);
        for (let left = 0; left < topLevel.length; left += 1) {
          for (let right = left + 1; right < topLevel.length; right += 1) {
            expect(overlaps(topLevel[left]!, topLevel[right]!)).toBe(false);
          }
        }
        for (const entry of snapshot.rows) {
          const rowRight = entry.row.x + entry.row.width;
          const rowBottom = entry.row.y + entry.row.height;
          for (const text of [entry.label, entry.description]) {
            expect(text.x).toBeGreaterThanOrEqual(entry.row.x);
            expect(text.y).toBeGreaterThanOrEqual(entry.row.y);
            expect(text.x + text.width).toBeLessThanOrEqual(rowRight);
            expect(text.y + text.height).toBeLessThanOrEqual(rowBottom);
          }
          expect(overlaps(entry.label, entry.description)).toBe(false);
        }

        const content = await mainSceneProbe.getModalPickerContent(page);
        expect(content, 'real boss reward picker content was unavailable').not.toBeNull();
        expect(content!.options.length).toBeGreaterThan(0);
        for (const option of content!.options) {
          // Prose first, then the authored numbers the player is choosing between.
          expect(option.description, `${option.id} shows no stat line`).toMatch(
            /\n.*(Damage|Heals|Radius|Range|Slow|Duration|Knockback|Move Speed|Armor|Accuracy).*\d/,
          );
        }
      } finally {
        await context.close();
      }
    }, 180_000);
  }

  it('projects a confirmed reward through loadout, hotbar, and mastery state', async () => {
    context = await browser.newContext({ viewport: VIEWPORTS[0] });
    page = await context.newPage();
    try {
      await loadMainSceneProbeLab(page);
      await mainSceneProbe.openBossRewardPicker(page);
      const content = await mainSceneProbe.getModalPickerContent(page);
      const reward = content?.options[0];
      expect(reward, 'boss reward picker must offer a selectable ability').toBeDefined();

      await page.keyboard.press('Enter');
      await expect.poll(async () => (await mainSceneProbe.getState(page)).modalOpen).toBe(false);
      await mainSceneProbe.advanceSimulationFrames(page, 2);

      const rewarded = await mainSceneProbe.getState(page);
      expect(rewarded.equippedActiveAbilityIds).toContain(reward!.id);
      expect(rewarded.hudAbilityIds).toContain(reward!.id);
      expect(rewarded.hudMasteryLabels).toContain(reward!.label);

      await mainSceneProbe.setSafeContext(page, true);
      await mainSceneProbe.setWorldState(page, 'safe_room');
      await mainSceneProbe.queueAbilitiesToggle(page);
      await expect
        .poll(async () => (await mainSceneProbe.getState(page)).abilityLoadoutOpen)
        .toBe(true);

      const loadout = await mainSceneProbe.getState(page);
      const rewardIndex = loadout.abilityLoadoutVisibleEntries.findIndex(
        (entry) => entry.id === reward!.id,
      );
      expect(
        rewardIndex,
        'rewarded ability must appear in the production loadout',
      ).toBeGreaterThanOrEqual(0);
      for (let index = 0; index < rewardIndex; index += 1) {
        await page.keyboard.press('ArrowDown');
      }

      await page.keyboard.press('Enter');
      await expect
        .poll(async () => (await mainSceneProbe.getState(page)).equippedActiveAbilityIds)
        .not.toContain(reward!.id);
      await mainSceneProbe.queueAbilitiesToggle(page);
      await expect
        .poll(async () => (await mainSceneProbe.getState(page)).abilityLoadoutOpen)
        .toBe(false);
      await mainSceneProbe.advanceSimulationFrames(page, 2);
      await expect
        .poll(async () => (await mainSceneProbe.getState(page)).hudAbilityIds)
        .not.toContain(reward!.id);
      expect((await mainSceneProbe.getState(page)).hudMasteryLabels).not.toContain(reward!.label);

      await mainSceneProbe.queueAbilitiesToggle(page);
      await expect
        .poll(async () => (await mainSceneProbe.getState(page)).abilityLoadoutOpen)
        .toBe(true);
      for (let index = 0; index < rewardIndex; index += 1) {
        await page.keyboard.press('ArrowDown');
      }
      await page.keyboard.press('Enter');
      await expect
        .poll(async () => (await mainSceneProbe.getState(page)).equippedActiveAbilityIds)
        .toContain(reward!.id);
      await mainSceneProbe.queueAbilitiesToggle(page);
      await expect
        .poll(async () => (await mainSceneProbe.getState(page)).abilityLoadoutOpen)
        .toBe(false);
      await mainSceneProbe.advanceSimulationFrames(page, 2);
      const reequipped = await mainSceneProbe.getState(page);
      expect(reequipped.hudAbilityIds).toContain(reward!.id);
      expect(reequipped.hudMasteryLabels).toContain(reward!.label);

      await mainSceneProbe.unlockSafeRoomSurfaces(page);
      await mainSceneProbe.requestInventoryToggle(page);
      await mainSceneProbe.advanceSimulationFrames(page, 2);
      await expect.poll(async () => (await mainSceneProbe.getState(page)).inventoryOpen).toBe(true);
      const inventoryOpen = await mainSceneProbe.getState(page);
      expect(inventoryOpen.hudAbilityIds).toEqual([]);
      expect(inventoryOpen.hudMasteryLabels).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);
});
