/**
 * Deterministic real-Phaser capture + text-geometry helpers for the equipment
 * panel.
 *
 * Two jobs:
 *
 * 1. **Capture** — drive the `ui-probe-lab` into one fixed, seeded equipment
 *    state and write a PNG of the panel. The output directory is selected by
 *    `EQUIPMENT_CAPTURE_PHASE` (`before` | `after`, default `after`) so the same
 *    code path produces both halves of a visual-review pair:
 *      files/visual-review/before/equipment.png
 *      files/visual-review/after/equipment.png
 *
 * 2. **Text geometry** — read every `Phaser.GameObjects.Text` inside the
 *    equipment panel's container out of the live scene, in design space
 *    (1280×720), together with its authored font size. That is what lets the
 *    e2e suite assert "no clipping, no overlap, still readable" as a
 *    deterministic per-viewport gate instead of a human eyeballing a PNG.
 *
 * The panel is authored in design space and rendered under `Phaser.Scale.FIT`,
 * so design-space geometry is viewport-invariant while the *physical* pixel
 * size of a glyph is not — the readability check therefore converts the
 * authored font size through the live canvas rect.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Page } from 'playwright';
import type { ScreenBounds } from '../../../src/engine/ui-scale.js';
import { getCanvasRect, type CanvasRect } from './ui-probe.js';

/** One text run inside the equipment panel, in design-space coordinates. */
export interface PanelTextBox {
  /** Rendered string (trimmed). */
  readonly text: string;
  /** Authored font size in design pixels (e.g. 8 for `'8px'`). */
  readonly fontSize: number;
  /** Design-space bounds of the rendered glyph run. */
  readonly bounds: ScreenBounds;
}

/**
 * Minimum physical glyph height, in device-independent CSS pixels, that we
 * accept as readable for the panel's 8px pixel font.
 *
 * `Press Start 2P` is a full-height pixel face (no descender slack), so a glyph
 * box maps 1:1 to the authored font size. Below ~6 CSS px the stat rows stop
 * resolving into distinct characters on a standard display.
 */
export const MIN_READABLE_GLYPH_PX = 6;

/**
 * Convert an authored/uiScaled font size into the physical CSS pixels it
 * actually occupies at this canvas rect.
 *
 * The panel is authored in a 1280×720 design space under `Phaser.Scale.FIT`, so
 * the canvas letterboxes rather than reflowing: design geometry is
 * viewport-invariant but physical glyph size is not. This is the only part of
 * the readability gate that is allowed to vary per viewport.
 */
export function physicalGlyphPx(renderedFontSize: number, rect: CanvasRect): number {
  return renderedFontSize * (rect.width / DESIGN_WIDTH);
}

const DESIGN_WIDTH = 1280;

/** Hide lab DOM chrome that would otherwise occlude the canvas in a capture. */
async function hideCaptureChrome(page: Page): Promise<void> {
  await page.evaluate(() => {
    // `lab.html` renders a floating "›" toggle that sits ON TOP of the canvas,
    // so hiding `#lab-controls` alone still leaves a button over the panel.
    document.getElementById('controls-toggle')?.style.setProperty('display', 'none');
  });
}

export type CapturePhase = 'before' | 'after';

function capturePhase(): CapturePhase {
  return process.env.EQUIPMENT_CAPTURE_PHASE === 'before' ? 'before' : 'after';
}

/** Canonical visual-review artifact path for the current phase. */
export function captureArtifactPath(name: string, phase: CapturePhase = capturePhase()): string {
  const version = process.env.EQUIPMENT_CAPTURE_VERSION?.trim();
  const statePath = version ? join(phase, version) : phase;
  return resolve(process.cwd(), 'files', 'visual-review', statePath, `${name}.png`);
}

function writeArtifact(buffer: Buffer, absolutePath: string): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, buffer);
}

/**
 * Put the probe lab into the canonical "decision" state used by every capture
 * and by the readability gate: real generated art, a partly-filled paper doll,
 * gear still left in the bag, and the inspector previewing a real equip delta.
 *
 * Deterministic by construction — the lab seeds from a fixed world seed and we
 * only ever drive it through the probe API (never through timing-dependent
 * synthesized pointer moves).
 */
export async function seedEquipmentDecisionState(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const probe = window.__uiProbe!;
    await probe.useRealGeneratedSprites();
    probe.openEquipmentOnly();
    probe.seedAllGear();
    probe.equipCharm();
    const seeded = probe.getEquipmentBagItemIds();
    for (const id of seeded.slice(0, 4)) {
      probe.equipFromEquipmentBag(id);
    }
  });
  await page.waitForTimeout(400);
  // Set the preview LAST: the panel only re-renders on a signature change, so
  // nothing after this wipes the inspector content we want captured/asserted.
  await page.evaluate(() => {
    const probe = window.__uiProbe!;
    const remaining = probe.getEquipmentBagItemIds();
    const previewId = remaining[1] ?? remaining[0];
    if (previewId) probe.previewEquipmentBagItem(previewId);
  });
  await page.waitForTimeout(250);
  await page.waitForFunction(
    () => window.__uiProbe?.getEquipmentTextRasterMetadata()?.fontLoadState === 'loaded',
    undefined,
    { timeout: 10_000 },
  );
}

/**
 * Screenshot the equipment panel (plus a small margin) from the live canvas.
 * Returns the PNG buffer and the clip actually used.
 */
export async function captureEquipmentPanel(
  page: Page,
  outPath: string,
): Promise<{ buffer: Buffer; rect: CanvasRect }> {
  await hideCaptureChrome(page);
  const rect = await getCanvasRect(page);
  const game = await page.evaluate(() => window.__uiProbe!.getGameSize());
  const panel = await page.evaluate(() => window.__uiProbe!.getEquipmentPanelBounds());
  const sx = rect.width / game.width;
  const sy = rect.height / game.height;
  const pad = 16;
  const clip = {
    x: Math.max(0, Math.floor(rect.x + panel.x * sx - pad)),
    y: Math.max(0, Math.floor(rect.y + panel.y * sy - pad)),
    width: Math.ceil(panel.width * sx + pad * 2),
    height: Math.ceil(panel.height * sy + pad * 2),
  };
  const buffer = await page.screenshot({ type: 'png', clip });
  writeArtifact(buffer, outPath);
  return { buffer, rect };
}

/** Does rect `inner` sit fully inside rect `outer` (with `slack` px tolerance)? */
export function containsWithin(outer: ScreenBounds, inner: ScreenBounds, slack = 0): boolean {
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  );
}

/** Do two rects overlap by more than `slack` px on BOTH axes? */
export function overlapArea(a: ScreenBounds, b: ScreenBounds): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
