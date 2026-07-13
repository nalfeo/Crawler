/**
 * ui-scale — responsive UI scaling for the screen-space HUD and menu overlays.
 *
 * The game renders at a fixed design resolution (GAME.WIDTH × GAME.HEIGHT) and
 * uses `Phaser.Scale.FIT`, so the whole canvas — including all UI drawn in
 * scene space — is scaled uniformly to fit the device. On a phone that shrinks
 * 12px HUD text and small −/+ buttons down to a few physical pixels, which is
 * hard to read and impossible to tap accurately.
 *
 * `computeUiScale` derives a multiplier from how small the canvas is actually
 * being displayed (its CSS pixel size) relative to the design size. On a desktop
 * the canvas is displayed at (or above) the design size, so the scale is clamped
 * to 1 and the UI keeps its authored look. On small screens the multiplier grows
 * (up to a cap) so callers can render bigger, tappable UI that stays legible.
 *
 * The pure `computeUiScale` lives here so it can be unit-tested without Phaser;
 * the scene helpers (`getUiScale`, `onUiScaleChange`) read the live display size
 * from the Phaser ScaleManager and notify callers when it changes (resize,
 * orientation change, etc.).
 *
 * Engine layer only (Phaser allowed). No imports from core/game/labs.
 */
import type Phaser from 'phaser';
import { GAME } from '../shared/constants.js';
import { getOnScreenScale } from './render-scale.js';

/**
 * Phaser's ScaleManager resize event name. Inlined as a string literal (rather
 * than `Phaser.Scale.Events.RESIZE`) so this module stays free of a runtime
 * Phaser import and `computeUiScale` can be unit-tested in a plain Node env.
 */
const SCALE_RESIZE_EVENT = 'resize';

/**
 * Axis-aligned screen rectangle in CSS/scene pixels (the same space a Phaser
 * `getBounds()` returns for a scroll-factor-0 UI object at camera zoom 1).
 *
 * Exposed by the canvas UI components purely as a test/automation affordance so
 * e2e harnesses can locate and tap canvas-rendered controls (which have no DOM
 * node) without re-deriving brittle layout math.
 */
export interface ScreenBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Never shrink the UI below its authored design size. */
export const MIN_UI_SCALE = 1;
/** Cap how large the UI can grow so it never swallows the whole screen. */
export const MAX_UI_SCALE = 2.5;

export interface ComputeUiScaleOptions {
  /** Design width the UI was authored against. Defaults to GAME.WIDTH. */
  readonly designWidth?: number;
  /** Design height the UI was authored against. Defaults to GAME.HEIGHT. */
  readonly designHeight?: number;
  /** Smallest allowed multiplier. Defaults to {@link MIN_UI_SCALE}. */
  readonly min?: number;
  /** Largest allowed multiplier. Defaults to {@link MAX_UI_SCALE}. */
  readonly max?: number;
}

/**
 * Compute a responsive UI multiplier from the displayed canvas size.
 *
 * `displayWidth`/`displayHeight` are the canvas's on-screen (CSS pixel) size.
 * The result is `max(designW / displayW, designH / displayH)` — i.e. how much
 * the canvas has shrunk on its tightest axis — clamped to `[min, max]` and
 * rounded to two decimals to avoid churn from sub-pixel resize noise.
 */
export function computeUiScale(
  displayWidth: number,
  displayHeight: number,
  options: ComputeUiScaleOptions = {},
): number {
  const designWidth = options.designWidth ?? GAME.WIDTH;
  const designHeight = options.designHeight ?? GAME.HEIGHT;
  const min = options.min ?? MIN_UI_SCALE;
  const max = options.max ?? MAX_UI_SCALE;

  // Guard against zero/NaN display sizes (pre-layout, headless, etc.): fall back
  // to the neutral minimum rather than dividing by zero.
  if (!(displayWidth > 0) || !(displayHeight > 0)) {
    return min;
  }

  const shrinkX = designWidth / displayWidth;
  const shrinkY = designHeight / displayHeight;
  const raw = Math.max(shrinkX, shrinkY);
  const clamped = Math.min(max, Math.max(min, raw));
  return Math.round(clamped * 100) / 100;
}

/** Read the canvas's current on-screen (CSS pixel) size from a scene. */
function readDisplaySize(scene: Phaser.Scene): { width: number; height: number } {
  const display = scene.scale.displaySize;
  if (display && display.width > 0 && display.height > 0) {
    return { width: display.width, height: display.height };
  }
  // Fallback for early-boot / headless: approximate with the window viewport.
  if (typeof window !== 'undefined') {
    return { width: window.innerWidth, height: window.innerHeight };
  }
  return { width: GAME.WIDTH, height: GAME.HEIGHT };
}

/** Current responsive UI multiplier for the given scene. */
export function getUiScale(scene: Phaser.Scene): number {
  const { width, height } = readDisplaySize(scene);
  return computeUiScale(width, height, {
    designWidth: GAME.WIDTH,
    designHeight: GAME.HEIGHT,
  });
}

/**
 * Responsive UI multiplier for a centred overlay of the given content size,
 * capped so the (scaled) content still fits inside the design canvas.
 *
 * Centred overlays are laid out in design space and scaled up by the returned
 * factor; without a cap a wide panel scaled by {@link getUiScale} could grow
 * past the canvas edges and be clipped. This clamps the scale to the largest
 * value where `contentWidth/Height × scale` still fits within the canvas (minus
 * `margin` on each axis), never dropping below 1 (the authored layout already
 * fits at scale 1).
 */
export function fitUiScale(
  scene: Phaser.Scene,
  contentWidth: number,
  contentHeight: number,
  margin = 16,
): number {
  const desired = getUiScale(scene);
  const widthFit = (GAME.WIDTH - margin * 2) / contentWidth;
  const heightFit = (GAME.HEIGHT - margin * 2) / contentHeight;
  const capped = Math.min(desired, widthFit, heightFit);
  return Math.max(1, Math.round(capped * 100) / 100);
}

/**
 * Pure: the scale factor that fits a source sprite of `srcWidth × srcHeight`
 * source pixels inside a square `box`-pixel target, preserving aspect ratio
 * ("contain" — the longest side lands within `box`).
 *
 * Sprite art must never be scaled against an assumed fixed source size: approved
 * assets range from 16×16 placeholders to 64×64 (or larger) generated art, so
 * callers derive the scale from the *actual* texture dimensions and pass them
 * here. Upscaling (source smaller than the box) snaps to the largest integer
 * scale that still fits, so nearest-neighbour pixel art stays crisp; downscaling
 * (source larger than the box) uses the exact fractional fit so higher-resolution
 * art lands precisely at the target size instead of overflowing. Degenerate
 * (non-positive) dimensions fall back to 1.
 */
export function fitScaleForBox(srcWidth: number, srcHeight: number, box: number): number {
  const longestSide = Math.max(srcWidth, srcHeight);
  if (!(longestSide > 0) || !(box > 0)) {
    return 1;
  }
  const exact = box / longestSide;
  return exact >= 1 ? Math.max(1, Math.floor(exact)) : exact;
}

/**
 * Subscribe to UI-scale changes. The callback fires whenever the canvas is
 * resized. The callback does not fire on subscription — call `getUiScale` for
 * the initial value. Returns an unsubscribe function.
 */
export function onUiScaleChange(
  scene: Phaser.Scene,
  callback: (scale: number) => void,
): () => void {
  let last = getUiScale(scene);
  const handler = (): void => {
    const next = getUiScale(scene);
    if (next !== last) {
      last = next;
      callback(next);
    }
  };
  scene.scale.on(SCALE_RESIZE_EVENT, handler);
  return () => {
    scene.scale.off(SCALE_RESIZE_EVENT, handler);
  };
}

/**
 * Upper bound on screen-space text render resolution. Phaser rasterises text to
 * an internal glyph texture `resolution`× larger than its font size; capping the
 * value stops long HUD strings from allocating oversized textures on 4K / high-DPI
 * displays while still covering every realistic on-screen pixel density.
 */
export const MAX_TEXT_RESOLUTION = 4;

export interface ComputeTextResolutionOptions {
  /** Largest allowed resolution. Defaults to {@link MAX_TEXT_RESOLUTION}. */
  readonly max?: number;
}

/**
 * Pure: the glyph render resolution that keeps screen-space text crisp.
 *
 * `onScreenScale` is the *continuous* design→physical magnification `M` (see
 * {@link getOnScreenScale}) — how many physical pixels each design pixel covers
 * on screen, residual `FIT` upscaling included — and `uiScale` is the responsive
 * HUD multiplier applied in design space. A glyph authored at font size `F`
 * covers `F × uiScale × onScreenScale` physical pixels, so its texture must be
 * rasterised at `resolution = ceil(uiScale × onScreenScale)` to fill that
 * footprint 1:1 instead of being nearest-neighbour upscaled (the cause of blurry
 * HUD text). `ceil` (never `round`) guarantees we oversample rather than
 * undersample, so the per-text resolution stays a true complementary layer to the
 * integer framebuffer render scale `S` even in the `S === 1` band where `S` has
 * rounded the residual magnification away. Clamped to `[1, max]`.
 */
export function computeTextResolution(
  onScreenScale: number,
  uiScale: number,
  options: ComputeTextResolutionOptions = {},
): number {
  const max = options.max ?? MAX_TEXT_RESOLUTION;
  const scale = onScreenScale > 0 ? onScreenScale : 1;
  const ui = uiScale > 0 ? uiScale : 1;
  return Math.min(max, Math.max(1, Math.ceil(scale * ui)));
}

/**
 * Live screen-space text resolution for a scene (see {@link computeTextResolution}).
 * Combines the continuous on-screen magnification (FIT residual + devicePixelRatio,
 * via {@link getOnScreenScale}) with the responsive HUD scale so HUD text stays
 * crisp — including the `S === 1` band where the framebuffer is not supersampled
 * but the canvas is still `FIT`-upscaled above the design size.
 */
export function getTextResolution(scene: Phaser.Scene): number {
  return computeTextResolution(getOnScreenScale(scene), getUiScale(scene));
}

/**
 * Set a crisp render resolution on screen-space text now and whenever the canvas
 * is resized, so HUD glyphs stay sharp instead of being nearest-neighbour
 * upscaled by `Phaser.Scale.FIT`. Returns an unsubscribe function the caller must
 * invoke on teardown.
 */
export function applyCrispText(
  scene: Phaser.Scene,
  texts: ReadonlyArray<Phaser.GameObjects.Text>,
  minimumResolution = 1,
): () => void {
  let lastResolution = 0;
  const apply = (): void => {
    const resolution = Math.max(minimumResolution, getTextResolution(scene));
    if (resolution === lastResolution) {
      return;
    }
    lastResolution = resolution;
    for (const text of texts) {
      text.setResolution(resolution);
    }
  };
  apply();
  scene.scale.on(SCALE_RESIZE_EVENT, apply);
  return () => {
    scene.scale.off(SCALE_RESIZE_EVENT, apply);
  };
}
