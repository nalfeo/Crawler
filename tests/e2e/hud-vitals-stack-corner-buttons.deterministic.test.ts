/**
 * Deterministic real-artifact coverage for the two regressions fixed alongside
 * nalfeo/Crawler#3681, measured on the **real booted MainGameScene** (via
 * `main-scene-probe-lab`, which boots the shipped floor bootstrap) rather than
 * on a HUD lab or on source strings:
 *
 *   1. **Vitals stack gap.** The bottom-left vitals widgets must stay in the
 *      shared `HudVitalsLayout` order after the loot readout was folded into
 *      the health panel. Asserted here by reading each row's real rendered zone
 *      bounds out of the live scene and measuring the inter-row gaps.
 *   2. **Corner-button uniformity.** Bag/Gear/Awards/... must stay identically
 *      sized, left-aligned and evenly stacked. Asserted from the live buttons'
 *      rendered bounds at both supported landscape viewports.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';
import { GAME_H, GAME_W } from './e2e-constants.js';

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 960, height: 540 },
] as const;

/**
 * `HudVitalsLayout` encodes a compact 2px gutter between stacked panels, but
 * the whole cluster is uniformly magnified by the responsive ui-scale, so the
 * rendered gaps are asserted as fractions of the rendered row height
 * (scale-free) instead of against raw design-space pixels.
 */
const MAX_LOWER_STACK_GAP_RATIO = 0.15;
/**
 * Authored inter-button spacing in `MainGameScene.applyMobileButtonScale`; the
 * buttons are scaled, so the rendered spacing is `8 * buttonScale` and is
 * asserted for uniformity across the column rather than as an absolute value.
 */
const CORNER_BUTTON_SPACING_TOLERANCE = 1;
const DEVICE_INSETS = { top: 0, right: 340, bottom: 100, left: 0 };
const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };
const SAFE_AREA_EDGES = ['top', 'right', 'bottom', 'left'] as const;

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SafeAreaLayout {
  insets: typeof DEVICE_INSETS;
  surfaces: Array<{ name: string; bounds: Bounds }>;
}

async function applySafeAreaInsets(page: Page, insets = DEVICE_INSETS): Promise<void> {
  const expectedInsets = await page.evaluate(
    ({ values, design }) => {
      for (const [edge, value] of Object.entries(values)) {
        document.documentElement.style.setProperty(
          `--crawler-safe-area-inset-${edge}`,
          `${value}px`,
          'important',
        );
      }
      window.dispatchEvent(new Event('resize'));
      const canvas = document.querySelector('canvas')?.getBoundingClientRect();
      if (!canvas) {
        return null;
      }
      const scaleX = design.width / canvas.width;
      const scaleY = design.height / canvas.height;
      const canvasRight = canvas.x + canvas.width;
      const canvasBottom = canvas.y + canvas.height;
      const clampX = (overlap: number): number =>
        Math.min(design.width, Math.max(0, overlap) * scaleX);
      const clampY = (overlap: number): number =>
        Math.min(design.height, Math.max(0, overlap) * scaleY);
      return {
        top: clampY(values.top - canvas.y),
        right: clampX(canvasRight - (window.innerWidth - values.right)),
        bottom: clampY(canvasBottom - (window.innerHeight - values.bottom)),
        left: clampX(values.left - canvas.x),
      };
    },
    { values: insets, design: { width: GAME_W, height: GAME_H } },
  );
  if (!expectedInsets) {
    throw new Error('safe-area inset test could not find the Phaser canvas');
  }
  await page.waitForFunction(
    ({ expected, edges }) => {
      const layout = window.__mainSceneProbe?.getSafeAreaLayout();
      if (!layout) return false;
      return edges.every((edge) => Math.abs(layout.insets[edge] - expected[edge]) < 0.001);
    },
    { expected: expectedInsets, edges: SAFE_AREA_EDGES },
    { timeout: 5_000, polling: 100 },
  );
}

async function waitForSurfaces(
  page: Page,
  names: readonly string[],
  timeoutMs = 15_000,
): Promise<SafeAreaLayout> {
  await page.waitForFunction(
    (surfaceNames) => {
      const layout = window.__mainSceneProbe?.getSafeAreaLayout();
      return (
        layout !== undefined &&
        surfaceNames.every((name) => layout.surfaces.some((surface) => surface.name === name))
      );
    },
    names,
    { timeout: timeoutMs, polling: 100 },
  );
  return mainSceneProbe.getSafeAreaLayout(page);
}

function overlaps(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

describe('real MainGameScene HUD vitals stack and corner buttons', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await closeQuietly(browser);
  });

  for (const viewport of VIEWPORTS) {
    it(`stacks vitals rows flush and corner buttons uniformly at ${viewport.width}x${viewport.height}`, async () => {
      let context: BrowserContext | undefined;
      try {
        context = await browser.newContext({ viewport });
        const page: Page = await context.newPage();
        await loadMainSceneProbeLab(page);
        await applySafeAreaInsets(page);
        // Resolve the starter-weapon loadout through the shipped path (the
        // skill tracker only renders once a weapon is equipped) and unlock the
        // drops flag the XP row is gated on.
        await mainSceneProbe.resolveLoadout(page);
        await mainSceneProbe.unlockExperienceBar(page);
        await page.waitForTimeout(300);

        const vitals = await mainSceneProbe.getVitalsStackBounds(page);
        const skill = vitals.skill;
        const xp = vitals.xp;
        const health = vitals.health;
        if (!skill || !xp || !health) {
          throw new Error(
            `vitals rows missing from the real scene: ${JSON.stringify({
              skill: Boolean(skill),
              xp: Boolean(xp),
              health: Boolean(health),
            })}`,
          );
        }

        // Every row renders (the XP row only after the drops unlock above).
        for (const [name, row] of [
          ['skill', skill],
          ['xp', xp],
          ['health', health],
        ] as const) {
          expect(row.visible, `${name} row must be rendered`).toBe(true);
          expect(row.bounds.height, `${name} row must have real height`).toBeGreaterThan(0);
        }

        // Rows stack top-down in the documented order with no overlap and no
        // gap wider than the authored gutter.
        const skillToXp = xp.bounds.y - (skill.bounds.y + skill.bounds.height);
        const xpToHealth = health.bounds.y - (xp.bounds.y + xp.bounds.height);

        expect(skillToXp, 'skill→XP gap').toBeGreaterThanOrEqual(0);
        expect(skillToXp, 'skill→XP gap').toBeLessThanOrEqual(
          xp.bounds.height * MAX_LOWER_STACK_GAP_RATIO,
        );
        expect(xpToHealth, 'XP→health gap').toBeGreaterThanOrEqual(0);
        expect(xpToHealth, 'XP→health gap').toBeLessThanOrEqual(
          xp.bounds.height * MAX_LOWER_STACK_GAP_RATIO,
        );

        // The stack shares one left edge and stays on-canvas.
        for (const row of [skill, xp, health]) {
          expect(row.bounds.x).toBeCloseTo(skill.bounds.x, 1);
          expect(row.bounds.y).toBeGreaterThanOrEqual(0);
        }
        // Probe bounds are design space (the scene keeps 1280x720 under FIT).
        expect(health.bounds.y + health.bounds.height).toBeLessThanOrEqual(GAME_H);

        // Unlock the shipped safe-room surfaces so the corner buttons are
        // actually shown by the real visibility gating, then read them back.
        await mainSceneProbe.unlockSafeRoomSurfaces(page);
        await page.waitForTimeout(300);
        const buttons = await mainSceneProbe.getCornerButtonLayout(page);
        expect(buttons.length, 'corner buttons must exist in the real scene').toBeGreaterThan(3);

        const shown = buttons.filter((button) => button.visible);
        expect(
          shown.map((button) => button.id),
          'the unlocked corner buttons must actually render',
        ).toEqual(expect.arrayContaining(['inventory', 'equip', 'abilities']));

        // Every rendered button stays fully on-canvas.
        for (const button of shown) {
          expect(button.bounds.x, `${button.id} left edge`).toBeGreaterThanOrEqual(0);
          expect(button.bounds.y, `${button.id} top edge`).toBeGreaterThanOrEqual(0);
          expect(
            button.bounds.x + button.bounds.width,
            `${button.id} right edge`,
          ).toBeLessThanOrEqual(GAME_W);
          expect(
            button.bounds.y + button.bounds.height,
            `${button.id} bottom edge`,
          ).toBeLessThanOrEqual(GAME_H);
        }

        const issue = shown.find((button) => button.id === 'issue');
        expect(issue, 'Issue button must render with the unlocked surfaces').toBeDefined();
        if (!issue) return;
        const npcTarget = await mainSceneProbe.primeNpcInteractionTarget(page);
        expect(npcTarget, 'probe should expose at least one NPC interaction target').not.toBeNull();
        const safeLayout = await waitForSurfaces(page, ['skillPanel', 'interactionHint']);
        expect(safeLayout.insets.right, 'test must exercise a nonzero right inset').toBeGreaterThan(
          0,
        );
        expect(
          safeLayout.insets.bottom,
          'test must exercise a nonzero bottom inset',
        ).toBeGreaterThan(0);
        const margin = 16;
        expect(issue.bounds.x).toBeGreaterThanOrEqual(
          GAME_W - safeLayout.insets.right - margin - issue.bounds.width,
        );
        expect(issue.bounds.y).toBeGreaterThanOrEqual(
          GAME_H - safeLayout.insets.bottom - margin - issue.bounds.height,
        );
        expect(issue.bounds.x + issue.bounds.width).toBeLessThanOrEqual(
          GAME_W - safeLayout.insets.right - margin,
        );
        expect(issue.bounds.y + issue.bounds.height).toBeLessThanOrEqual(
          GAME_H - safeLayout.insets.bottom - margin,
        );
        for (const surfaceName of ['skillPanel', 'interactionHint']) {
          const surface = safeLayout.surfaces.find(({ name }) => name === surfaceName);
          expect(surface, `${surfaceName} must be present before overlap assertion`).toBeDefined();
          expect(
            overlaps(issue.bounds, surface!.bounds),
            `Issue must not overlap ${surfaceName}`,
          ).toBe(false);
        }

        // Presentation, read off the *live* scene rather than source: every
        // rendered icon must be a colour-emoji code point, so no button falls
        // back to a smaller monochrome text glyph beside its neighbours. The
        // Quartermaster `✕` is a deliberate close affordance, not an icon.
        for (const button of buttons) {
          const [first, second] = [...button.label];
          const icon = second === '\uFE0F' ? `${first}${second}` : (first ?? '');
          if (icon === '✕') {
            continue;
          }
          const base = [...icon][0]!;
          expect(
            /\p{Emoji_Presentation}/u.test(base) ||
              (icon.endsWith('\uFE0F') && /\p{Emoji}/u.test(base)),
            `${button.id} icon "${icon}" must render as colour emoji`,
          ).toBe(true);
        }

        // Rendered heights are uniform across every button, Issue included.
        const allHeights = buttons.map((button) => button.bounds.height);
        expect(
          Math.max(...allHeights) - Math.min(...allHeights),
          'every corner button must render at the same height',
        ).toBeLessThanOrEqual(1);

        // Identical text styling must produce identical rendered height and a
        // shared left edge for every first-column button.
        const column = buttons.filter((button) => button.id !== 'issue');
        const firstHeight = column[0]!.bounds.height;
        const firstLeft = column[0]!.bounds.x;
        for (const button of column) {
          expect(button.bounds.height, `${button.id} height`).toBeCloseTo(firstHeight, 1);
          expect(button.bounds.x, `${button.id} left edge`).toBeCloseTo(firstLeft, 1);
        }

        // Uniform, non-overlapping vertical spacing down the column.
        const gaps: number[] = [];
        for (let i = 1; i < column.length; i += 1) {
          const previous = column[i - 1]!;
          const current = column[i]!;
          const gap = current.bounds.y - (previous.bounds.y + previous.bounds.height);
          expect(gap, `${previous.id}→${current.id} spacing`).toBeGreaterThan(0);
          gaps.push(gap);
        }
        expect(
          Math.max(...gaps) - Math.min(...gaps),
          `corner button spacing must be uniform (${gaps.join(', ')})`,
        ).toBeLessThanOrEqual(CORNER_BUTTON_SPACING_TOLERANCE);

        // Reset to the ordinary desktop safe rect before opening Gear: this is
        // the tight 100px right gutter where the full text button regressed.
        await applySafeAreaInsets(page, ZERO_INSETS);
        await mainSceneProbe.requestEquipToggle(page);
        await waitForState(page, (state) => state.equipmentOpen && state.issueButtonVisible, {
          label: 'equipment panel open with visible Issue affordance',
        });
        const equipmentPanel = await mainSceneProbe.getEquipmentPanelBounds(page);
        expect(equipmentPanel, 'Equipment panel must expose live bounds when open').not.toBeNull();
        const compactIssue = (await mainSceneProbe.getCornerButtonLayout(page)).find(
          (button) => button.id === 'issue',
        );
        expect(compactIssue, 'Issue button must still exist while Gear is open').toBeDefined();
        expect(compactIssue?.visible, 'Issue button must remain visible while Gear is open').toBe(
          true,
        );
        const compactIssueLabel = await mainSceneProbe.getIssueButtonCompactLabel(page);
        expect(compactIssue?.label, 'Issue uses the compact panel-open affordance').toBe(
          compactIssueLabel,
        );
        expect(
          overlaps(compactIssue!.bounds, equipmentPanel!),
          'Issue must not overlap the open Gear panel',
        ).toBe(false);
      } finally {
        await closeQuietly(context);
      }
    }, 120_000);
  }
});
