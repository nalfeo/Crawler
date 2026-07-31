/**
 * Unified door-render guard (real MainGameScene), Floor 1 AND Floor 2.
 *
 * DELIBERATE INVERSION. This file replaces two pack-era tests that asserted the
 * behaviour this change removes:
 *   - `generated-door-overlay.test.ts` asserted `closedPackCount ===
 *     renderableClosedCount` and `closedGeneratedCount === 0` on Floor 1.
 *   - `floor2-pack-door-overlay.test.ts` asserted `openPackCount > 0` on Floor 2.
 * Terrain packs no longer ship door art at all, so those gates cannot pass and
 * are not weakened — they are inverted on purpose: what used to be required
 * (pack art wins) is now impossible, and what used to be forbidden on Floor 1
 * (generated art) is now the only correct answer. The bucket count did not drop:
 * `crossOrientationCount` was ADDED, so the guard is strictly stronger.
 *
 * Why e2e (not a lab-only claim): a unit test proves `resolveDoorRenderMode`
 * picks a key in isolation, but ONLY the real MainGameScene boots a floor,
 * preloads the approved generated sprite registry, and runs the per-frame door
 * overlay (AGENTS.md rule #9: lab-only validation is insufficient). The
 * `main-scene-probe-lab` HOSTS the real scene through the shipped bootstrap, so
 * `getDoorRenderSummary()` observes the actual engine render path.
 *
 * Floor coverage is deliberately BOTH floors because they exercise opposite
 * door states: a freshly booted Floor 1 (room-heavy stone dungeon) is all CLOSED
 * doors, while the `cave_system` generator that builds Floor 2 stamps every
 * room-connector door as DOOR_OPEN, so Floor 2 is all OPEN. Testing one floor
 * would leave half the art contract unobserved.
 *
 * Determinism: fixed `worldSeed` (the lab's PROBE_SEED); assertions are exact
 * integer identities with no wall-clock or RNG input. The `renderable*Count > 0`
 * precondition guards against a false pass on a map with no eligible doors.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('Unified door render guard', () => {
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

  it('renders every CLOSED Floor 1 door from generated art, with no fallback', async () => {
    await loadMainSceneProbeLab(page);

    // Doors are drawn in the per-frame overlay pass (not the one-shot terrain
    // bake), so poll a few frames for the summary to settle.
    let summary = await mainSceneProbe.getDoorRenderSummary(page);
    const deadline = Date.now() + 5_000;
    while (summary.renderableClosedCount === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
      summary = await mainSceneProbe.getDoorRenderSummary(page);
    }

    // Precondition: the booted map actually has eligible closed doors. A 0 here
    // means "no test subject", NOT "wrong branch" — a loud, diagnosable failure
    // rather than a silent false pass.
    expect(
      summary.renderableClosedCount,
      `booted Floor 1 should have at least one closed wall-flanked door; summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    // Core gate (inverted from the pack era): EVERY closed door stamps the
    // approved GENERATED texture. Pack art can no longer win because packs no
    // longer carry door art.
    expect(
      summary.closedGeneratedCount,
      `every closed door should render generated art; summary=${JSON.stringify(summary)}`,
    ).toBe(summary.renderableClosedCount);

    expect(
      summary.closedKenneyCount + summary.closedColorCount,
      `no closed door should fall back to Kenney/color; summary=${JSON.stringify(summary)}`,
    ).toBe(0);

    // Orientation contract: an E/W doorway must use side-on art and an N/S
    // doorway face-on art. A non-zero count means a real art gap, not a
    // rendering bug — it is asserted, never tolerated.
    expect(
      summary.crossOrientationCount,
      `no door should borrow the other orientation's art; summary=${JSON.stringify(summary)}`,
    ).toBe(0);
  });

  it('renders every OPEN Floor 2 door from generated art, with no fallback', async () => {
    await loadMainSceneProbeLab(page, { floor: 'floor2' });

    let summary = await mainSceneProbe.getDoorRenderSummary(page);
    const deadline = Date.now() + 5_000;
    while (summary.renderableOpenCount === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
      summary = await mainSceneProbe.getDoorRenderSummary(page);
    }

    expect(
      summary.renderableOpenCount,
      `booted Floor 2 should have at least one open wall-flanked door; summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    expect(
      summary.openGeneratedCount,
      `every open door should render generated art; summary=${JSON.stringify(summary)}`,
    ).toBe(summary.renderableOpenCount);

    expect(
      summary.openKenneyCount + summary.openColorCount,
      `no open door should fall back to Kenney/color; summary=${JSON.stringify(summary)}`,
    ).toBe(0);

    expect(
      summary.crossOrientationCount,
      `no door should borrow the other orientation's art; summary=${JSON.stringify(summary)}`,
    ).toBe(0);
  });
});
