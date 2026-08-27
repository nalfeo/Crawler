/**
 * Observe-before-done evidence for issue #3690: an enemy under a status effect
 * must be visibly marked.
 *
 * This boots the REAL {@link MainGameScene} through the shipped floor bootstrap
 * (`main-scene-probe-lab`), spawns a live enemy beside the player, and compares
 * screenshots of the exact same scene before and after the real Curse slow
 * debuff is applied. The "before" screenshot is the pre-fix behavior — the
 * subtle multiply tint that was the only cue — and the "after" screenshot is
 * the shipped aura.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { colorDist, parsePng, readPixel } from './helpers/pixels.js';
import { closeQuietly } from './helpers/ui-probe.js';
import { loadMainSceneProbeLab, mainSceneProbe, waitForState } from './helpers/main-scene-probe.js';
import { GAME_W } from './e2e-constants.js';

/** Half-width of the sampled box around the enemy, in screen pixels. */
const SAMPLE_HALF_PX = 40;

function changedPixelRatio(
  beforeBuffer: Buffer,
  afterBuffer: Buffer,
  rect: { x: number; y: number; w: number; h: number },
  threshold = 12,
): number {
  const before = parsePng(beforeBuffer);
  const after = parsePng(afterBuffer);
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(before.width - 1, Math.round(rect.x + rect.w));
  const y1 = Math.min(before.height - 1, Math.round(rect.y + rect.h));
  let changed = 0;
  let total = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      total += 1;
      if (colorDist(readPixel(before, x, y), readPixel(after, x, y)) > threshold) changed += 1;
    }
  }
  return total === 0 ? 0 : changed / total;
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
    const canvas = page.locator('canvas').first();
    const beforeShot = await canvas.screenshot();

    // ── After: the real slow debuff is applied to that same enemy ─────────
    expect(await mainSceneProbe.applyStatusAuraDebuff(page, enemy!.enemyEid)).toBe(true);
    await mainSceneProbe.advanceSimulationFrames(page, 1);

    const after = await mainSceneProbe.getStatusAuraRenderSummary(page);
    expect(after.affectedEnemyCount).toBe(1);
    expect(after.layerPresent).toBe(true);
    expect(after.layerVisible).toBe(true);
    expect(after.drawCommandCount).toBeGreaterThan(0);

    const afterShot = await canvas.screenshot();

    // The canvas is letterboxed/scaled to the viewport, so convert the
    // camera-relative game position into screenshot pixels before sampling.
    const box = await canvas.boundingBox();
    const scale = (box?.width ?? GAME_W) / GAME_W;
    const cameraPos = await mainSceneProbe.getEntityCameraPosition(page, enemy!.enemyEid);
    expect(cameraPos).not.toBeNull();
    const auraDiff = changedPixelRatio(beforeShot, afterShot, {
      x: cameraPos!.x * scale - SAMPLE_HALF_PX,
      y: cameraPos!.y * scale - SAMPLE_HALF_PX,
      w: SAMPLE_HALF_PX * 2,
      h: SAMPLE_HALF_PX * 2,
    });
    // Recorded observation (issue #3690): ~21% of the sampled box around the
    // enemy changes once the debuff lands; the aura layer drew nothing at all
    // before it, which is exactly the "no visual effect" the issue reports.
    expect(auraDiff).toBeGreaterThan(0.01);
  }, 120_000);
});
