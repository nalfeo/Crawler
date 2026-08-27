/**
 * Deterministic real-artifact coverage for the two regressions fixed alongside
 * nalfeo/Crawler#3681, measured on the **real booted MainGameScene** (via
 * `main-scene-probe-lab`, which boots the shipped floor bootstrap) rather than
 * on a HUD lab or on source strings:
 *
 *   1. **Vitals stack gap.** The loot/currency pill drifted ~28px above where
 *      the shared `HudVitalsLayout` stack put it, reopening a visible gap above
 *      the XP bar. Asserted here by reading each row's real rendered zone
 *      bounds out of the live scene and measuring the inter-row gaps.
 *   2. **Corner-button uniformity.** Bag/Gear/Awards/... must stay identically
 *      sized, left-aligned and evenly stacked. Asserted from the live buttons'
 *      rendered bounds at both supported landscape viewports.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';
import { GAME_H } from './e2e-constants.js';

const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 960, height: 540 },
] as const;

/**
 * `HudVitalsLayout` encodes an 8px skill→loot gutter and a 2px gutter for the
 * lower stack, but the whole cluster is uniformly magnified by the responsive
 * ui-scale, so the rendered gaps are asserted as fractions of the rendered row
 * height (scale-free) instead of against raw design-space pixels. The pre-fix
 * loot pill sat a full row height clear of the XP bar, far outside these bands.
 */
const MAX_SKILL_TO_LOOT_GAP_RATIO = 0.4;
const MAX_LOWER_STACK_GAP_RATIO = 0.15;
/**
 * Authored inter-button spacing in `MainGameScene.applyMobileButtonScale`; the
 * buttons are scaled, so the rendered spacing is `8 * buttonScale` and is
 * asserted for uniformity across the column rather than as an absolute value.
 */
const CORNER_BUTTON_SPACING_TOLERANCE = 1;

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
        await mainSceneProbe.unlockExperienceBar(page);
        await page.waitForTimeout(300);

        const vitals = await mainSceneProbe.getVitalsStackBounds(page);
        const skill = vitals.skill;
        const loot = vitals.loot;
        const xp = vitals.xp;
        const health = vitals.health;
        if (!skill || !loot || !xp || !health) {
          throw new Error(
            `vitals rows missing from the real scene: ${JSON.stringify({
              skill: Boolean(skill),
              loot: Boolean(loot),
              xp: Boolean(xp),
              health: Boolean(health),
            })}`,
          );
        }

        // Every row renders (the XP row only after the drops unlock above).
        for (const [name, row] of [
          ['skill', skill],
          ['loot', loot],
          ['xp', xp],
          ['health', health],
        ] as const) {
          expect(row.visible, `${name} row must be rendered`).toBe(true);
          expect(row.bounds.height, `${name} row must have real height`).toBeGreaterThan(0);
        }

        // Rows stack top-down in the documented order with no overlap and no
        // gap wider than the authored gutter — the exact regression that
        // reopened when the loot pill hardcoded its own offset.
        const skillToLoot = loot.bounds.y - (skill.bounds.y + skill.bounds.height);
        const lootToXp = xp.bounds.y - (loot.bounds.y + loot.bounds.height);
        const xpToHealth = health.bounds.y - (xp.bounds.y + xp.bounds.height);

        expect(skillToLoot, 'skill→loot gap').toBeGreaterThanOrEqual(0);
        expect(skillToLoot, 'skill→loot gap').toBeLessThanOrEqual(
          loot.bounds.height * MAX_SKILL_TO_LOOT_GAP_RATIO,
        );
        expect(lootToXp, 'loot→XP gap (issue #3681)').toBeGreaterThanOrEqual(0);
        expect(lootToXp, 'loot→XP gap (issue #3681)').toBeLessThanOrEqual(
          loot.bounds.height * MAX_LOWER_STACK_GAP_RATIO,
        );
        expect(xpToHealth, 'XP→health gap').toBeGreaterThanOrEqual(0);
        expect(xpToHealth, 'XP→health gap').toBeLessThanOrEqual(
          xp.bounds.height * MAX_LOWER_STACK_GAP_RATIO,
        );

        // The stack shares one left edge and stays on-canvas.
        for (const row of [skill, loot, xp, health]) {
          expect(row.bounds.x).toBeCloseTo(skill.bounds.x, 1);
          expect(row.bounds.y).toBeGreaterThanOrEqual(0);
        }
        // Probe bounds are design space (the scene keeps 1280x720 under FIT).
        expect(health.bounds.y + health.bounds.height).toBeLessThanOrEqual(GAME_H);

        const buttons = await mainSceneProbe.getCornerButtonLayout(page);
        expect(buttons.length, 'corner buttons must exist in the real scene').toBeGreaterThan(3);

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
      } finally {
        await closeQuietly(context);
      }
    }, 120_000);
  }
});
