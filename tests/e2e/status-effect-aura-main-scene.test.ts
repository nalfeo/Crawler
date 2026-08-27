/**
 * Observe-before-done evidence for issue #3690: an enemy under a status effect
 * must be visibly marked.
 *
 * This boots the REAL {@link MainGameScene} through the shipped floor bootstrap
 * (`main-scene-probe-lab`), spawns a live enemy beside the player, applies the
 * real Curse slow debuff, and then isolates the aura: with the debuff (and its
 * multiply tint) held constant, only the shared aura layer's alpha is toggled,
 * and the additive brightening it adds is compared against the drift between
 * two consecutive aura-off frames. That separates the aura both from the status
 * tint and from anything the render clock advances between captures.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { parsePng, readPixel, type PixelRgb } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';
import { GAME_W } from './e2e-constants.js';

/** Half-width of the sampled box around the enemy, in screen pixels. */
const SAMPLE_HALF_PX = 40;
/** Per-pixel luma gain that counts as "this pixel was lit by something". */
const BRIGHTENED_LUMA_GAIN = 12;

function luma(pixel: PixelRgb): number {
  return 0.299 * pixel.r + 0.587 * pixel.g + 0.114 * pixel.b;
}

/**
 * Count pixels in `rect` that got BRIGHTER between two screenshots.
 *
 * Brightening is the aura's own signature: the layer is additive, while the
 * status tint is a multiply that can only ever darken a sprite. Measuring gain
 * rather than raw difference therefore keeps a tint change, a sprite-animation
 * step, or any camera drift from being mistaken for the aura.
 */
function brightenedPixels(
  beforeBuffer: Buffer,
  afterBuffer: Buffer,
  rect: { x: number; y: number; w: number; h: number },
): { count: number; maxGain: number } {
  const before = parsePng(beforeBuffer);
  const after = parsePng(afterBuffer);
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(before.width - 1, Math.round(rect.x + rect.w));
  const y1 = Math.min(before.height - 1, Math.round(rect.y + rect.h));
  let count = 0;
  let maxGain = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const gain = luma(readPixel(after, x, y)) - luma(readPixel(before, x, y));
      if (gain > BRIGHTENED_LUMA_GAIN) count += 1;
      if (gain > maxGain) maxGain = gain;
    }
  }
  return { count, maxGain };
}

describe('MainGameScene status-effect aura', () => {
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

  it('marks a debuffed enemy with a visible aura in the real scene', async () => {
    await loadMainSceneProbeLab(page);
    await mainSceneProbe.resolveLoadout(page);
    await waitForState(page, (s) => s.worldState === 'playing' && s.simulationPaused, {
      label: 'playing + paused scene',
    });

    const enemy = await mainSceneProbe.primeStatusAuraEnemy(page);
    expect(enemy).not.toBeNull();
    await mainSceneProbe.advanceSimulationFrames(page, 1);

    // ── Before: a live, unaffected enemy — no aura layer content ──────────
    const before = await mainSceneProbe.getStatusAuraRenderSummary(page);
    expect(before.affectedEnemyCount).toBe(0);
    expect(before.layerVisible).toBe(false);
    expect(before.drawCommandCount).toBe(0);

    // ── After: the real slow debuff is applied to that same enemy ─────────
    expect(await mainSceneProbe.applyStatusAuraDebuff(page, enemy!.enemyEid)).toBe(true);
    await mainSceneProbe.advanceSimulationFrames(page, 1);

    const after = await mainSceneProbe.getStatusAuraRenderSummary(page);
    expect(after.affectedEnemyCount).toBe(1);
    expect(after.layerPresent).toBe(true);
    expect(after.layerVisible).toBe(true);
    expect(after.drawCommandCount).toBeGreaterThan(0);

    // ── Isolate the aura itself ───────────────────────────────────────────
    // Every screenshot below is taken with the debuff ALREADY applied, so the
    // status tint is identical in all three. The only variable is the alpha of
    // the shared aura layer, which the shipped renderer never writes. Two
    // control frames at alpha 0 measure how much the sampled box drifts on its
    // own (sprite animation, ambient motion); the third frame adds the aura and
    // nothing else. An aura that rendered invisibly would leave the third diff
    // indistinguishable from that control drift.
    const canvas = page.locator('canvas').first();
    expect(await mainSceneProbe.setStatusAuraLayerAlpha(page, 0)).toBe(true);
    await mainSceneProbe.advanceSimulationFrames(page, 1);
    const controlShotA = await canvas.screenshot();
    await mainSceneProbe.advanceSimulationFrames(page, 1);
    const controlShotB = await canvas.screenshot();

    expect(await mainSceneProbe.setStatusAuraLayerAlpha(page, 1)).toBe(true);
    await mainSceneProbe.advanceSimulationFrames(page, 1);
    const auraShot = await canvas.screenshot();

    // The canvas is letterboxed/scaled to the viewport, so convert the
    // camera-relative game position into screenshot pixels before sampling.
    const box = await canvas.boundingBox();
    const scale = (box?.width ?? GAME_W) / GAME_W;
    const cameraPos = await mainSceneProbe.getEntityCameraPosition(page, enemy!.enemyEid);
    expect(cameraPos).not.toBeNull();
    const sampleRect = {
      x: cameraPos!.x * scale - SAMPLE_HALF_PX,
      y: cameraPos!.y * scale - SAMPLE_HALF_PX,
      w: SAMPLE_HALF_PX * 2,
      h: SAMPLE_HALF_PX * 2,
    };
    const controlDiff = brightenedPixels(controlShotA, controlShotB, sampleRect);
    const auraDiff = brightenedPixels(controlShotB, auraShot, sampleRect);

    // Recorded observation (issue #3690): with the debuff held constant, two
    // aura-off frames brighten nothing at all in the sampled box (0 px), while
    // switching the aura on lights up the ring under the enemy's feet (39 px,
    // peak +84 luma). Because the metric counts BRIGHTENING only, neither the
    // multiply status tint nor a sprite-animation step can produce it — an aura
    // that rendered invisibly would leave these two numbers indistinguishable.
    expect(controlDiff.count).toBeLessThan(5);
    expect(auraDiff.count).toBeGreaterThan(controlDiff.count * 4 + 15);
    expect(auraDiff.maxGain).toBeGreaterThan(40);
  }, 120_000);
});
