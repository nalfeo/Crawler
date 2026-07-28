/**
 * Terrain-pack closed-door render guard (real MainGameScene).
 *
 * Floor 1 ships the `floor1-dungeon` terrain pack, whose `doorSet` covers the
 * closed wooden door. When a pack is active, `updateDoorOverlay()` stamps the
 * pack's `doorSet` texture for every CLOSED wall-flanked door (`closedPackCount`),
 * while the OPEN state falls through to the Kenney open frame (no pack open-door
 * variant exists yet).
 *
 * Why e2e (not a lab-only claim): a green unit test proves `resolveDoorRenderMode`
 * chooses the pack branch in isolation, but ONLY the real MainGameScene loads the
 * pack atlas and runs the per-frame door overlay against a booted floor map
 * (AGENTS.md rule #10/#15: lab-only validation is insufficient — observe in a
 * real artifact). The `main-scene-probe-lab` HOSTS the real scene booted through
 * the shipped floor bootstrap (BootScene preloads the terrain pack → MainGameScene
 * draws doors each frame), so `getDoorRenderSummary()` observes the actual engine
 * render path.
 *
 * Determinism: fixed `worldSeed` (the lab's PROBE_SEED); freshly booted floors
 * have no player-opened doors, so every wall-flanked door is CLOSED and — with
 * the pack loaded — renders from the pack's doorSet. The assertion is an exact
 * integer identity (`closedPackCount === renderableClosedCount`) with no
 * wall-clock / RNG input. `renderableClosedCount > 0` guards against a false
 * pass on a map that happens to have no eligible closed door.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe } from './helpers/main-scene-probe.js';

describe('Terrain-pack closed-door render guard', () => {
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

  it('stamps the terrain-pack door texture on closed doors in the real booted scene', async () => {
    await loadMainSceneProbeLab(page);

    // Doors are drawn in the per-frame overlay pass (not the one-shot terrain
    // bake), so poll a few frames for the summary to settle. A freshly booted
    // Floor 1 is a room-heavy stone dungeon: its doorways start closed until the
    // player opens them, so renderableClosedCount should be > 0.
    let summary = await mainSceneProbe.getDoorRenderSummary(page);
    const deadline = Date.now() + 5_000;
    while (summary.renderableClosedCount === 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
      summary = await mainSceneProbe.getDoorRenderSummary(page);
    }

    // Precondition: the booted map actually has eligible (wall-flanked, closed)
    // doors to render. A 0 here means "no test subject", NOT "wrong branch" — a
    // loud, diagnosable failure rather than a silent false pass.
    expect(
      summary.renderableClosedCount,
      `booted Floor 1 should have at least one closed wall-flanked door to render; ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBeGreaterThan(0);

    // The core gate: EVERY renderable closed door stamps the pack's doorSet
    // texture. A Kenney-only render (the pre-pack behavior) would report
    // closedKenneyCount > 0 and closedPackCount === 0.
    expect(
      summary.closedPackCount,
      `every closed door should render the terrain-pack texture in the real scene; ` +
        `summary=${JSON.stringify(summary)}`,
    ).toBe(summary.renderableClosedCount);
    expect(summary.closedGeneratedCount).toBe(0);

    // Non-destructive guarantee: pack art must not leak into the open state.
    // (Freshly booted floors have no open doors, so this is 0 here regardless —
    // but the field existing and being 0 documents the intent.)
    expect(
      summary.closedKenneyCount + summary.closedColorCount,
      `no closed door should fall back to Kenney/color when the pack doorSet is ` +
        `wired; summary=${JSON.stringify(summary)}`,
    ).toBe(0);
  });
});
