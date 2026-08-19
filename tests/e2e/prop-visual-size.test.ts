/**
 * Floor-prop visual-size regression guard (real MainGameScene).
 *
 * Floor decorations (torches, barrels, etc.) used to render comically small:
 * `DecorationDef.scale` is documented as a "size multiplier relative to base
 * (1.0 = 100%)" but the Prop render pass in `PhaserBridge.ts` fed it straight
 * into `ftToPx()`, treating the multiplier as an absolute feet value. A torch
 * at `scale: 1.2` rendered at ~10px, dwarfed by the 3 ft player.
 *
 * Why e2e (not a lab reimplementation): `prop-lab` draws props as plain
 * canvas dots sized by its own bespoke scale-to-canvas-pixel math — it does
 * NOT use `PhaserBridge`'s Prop render pass, so a green prop-lab proves
 * nothing about the real render path. `main-scene-probe-lab` instead HOSTS
 * the real `MainGameScene` via the shipped floor bootstrap, so this observes
 * the actual `PhaserBridge` Prop render pass (per AGENTS.md rule #9 "observe
 * before done" / "lab-only validation is insufficient").
 *
 * Determinism: fixed `worldSeed` (PROBE_SEED=4242, baked into the lab),
 * simulation frozen after the loadout resolves, and the assertion compares
 * the observed display size against the production formula
 * `ftToPx(PROP_VISUAL_BASE_SIZE_FT * scale)` — no wall-clock/RNG input.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';
import { ftToPx } from '../../src/shared/units.js';
import { getDecorationDef } from '../../src/shared/decorationDefs.js';
import { _PROP_VISUAL_BASE_SIZE_FT } from '../../src/engine/PhaserBridge.js';

describe('Floor-prop visual-size render guard', () => {
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

  it('renders a torch prop at its full scaled footprint, not a ~10px speck', async () => {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'loadout resolved + simulation paused',
    });

    const torchSpriteId = getDecorationDef('torch')!.spriteId!;
    let sizes = await mainSceneProbe.getPropRenderSizes(page);
    const deadline = Date.now() + 8_000;
    while (!sizes.some((s) => s.textureKey === torchSpriteId) && Date.now() < deadline) {
      await page.waitForTimeout(100);
      sizes = await mainSceneProbe.getPropRenderSizes(page);
    }

    const torch = sizes.find((s) => s.textureKey === torchSpriteId);
    expect(torch, 'Floor 1 (dungeon biome) should spawn at least one torch prop').toBeDefined();

    const torchScale = getDecorationDef('torch')!.scale;
    const expectedPx = ftToPx(_PROP_VISUAL_BASE_SIZE_FT * torchScale);
    // Pre-fix this would have been ftToPx(torchScale) (~10px) — assert against
    // the production constant so the guard tracks the formula, not a copy of it.
    expect(torch!.displayWidthPx).toBeCloseTo(expectedPx);
    expect(torch!.displayHeightPx).toBeCloseTo(expectedPx);
  });
});
