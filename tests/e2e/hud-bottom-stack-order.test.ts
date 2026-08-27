import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function surfaceOf(
  layout: { surfaces: Array<{ name: string; bounds: Bounds }> },
  name: string,
): Bounds {
  const surface = layout.surfaces.find((entry) => entry.name === name);
  if (!surface) {
    throw new Error(
      `probe surface not found: ${name} (have: ${layout.surfaces.map((s) => s.name).join(', ')})`,
    );
  }
  return surface.bounds;
}

/**
 * Bottom-center stack order regression guard (issue #3679).
 *
 * The ability bar must sit flush with the bottom of the canvas and the
 * Talk/Descend interaction hint must stack directly above it. Before the fix
 * the order was inverted: the hint was pinned to the bottom edge and the
 * ability bar floated ~74 design-px above it.
 *
 * This drives the real MainGameScene (via the probe lab), not a lab-only
 * rendering of the ability bar, so it proves the shipped layout.
 */
describe('bottom-center HUD stack order', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();

    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'loadout resolved + simulation paused',
    });
    // Unlocks spells, which is what makes the ability bar render.
    await mainSceneProbe.unlockSafeRoomSurfaces(page);
    await waitForState(page, (s) => s.safeContext, { label: 'safe-room surfaces unlocked' });
  }, 240_000);

  afterAll(async () => {
    await closeQuietly(browser);
  });

  it('stacks the Talk hint above the bottom-anchored ability bar', async () => {
    const npcTarget = await mainSceneProbe.primeNpcInteractionTarget(page);
    expect(npcTarget, 'probe should expose at least one NPC interaction target').not.toBeNull();
    await page.waitForTimeout(400);

    const layout = await mainSceneProbe.getSafeAreaLayout(page);
    const abilityBar = surfaceOf(layout, 'bottomCenter');
    const hint = surfaceOf(layout, 'interactionHint');

    const abilityBarBottom = abilityBar.y + abilityBar.height;
    const hintBottom = hint.y + hint.height;

    // The ability bar owns the bottom edge of the canvas.
    expect(
      abilityBarBottom,
      'ability bar must reach the bottom band of the canvas',
    ).toBeGreaterThan(hintBottom);
    // ...and the hint clears its top edge entirely.
    expect(hintBottom, 'Talk hint must not overlap the ability bar').toBeLessThanOrEqual(
      abilityBar.y,
    );
  });
});
