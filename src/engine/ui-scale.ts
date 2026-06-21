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

/**
 * Phaser's ScaleManager resize event name. Inlined as a string literal (rather
 * than `Phaser.Scale.Events.RESIZE`) so this module stays free of a runtime
 * Phaser import and `computeUiScale` can be unit-tested in a plain Node env.
 */
const SCALE_RESIZE_EVENT = 'resize';

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
  return { width: scene.scale.width, height: scene.scale.height };
}

/** Current responsive UI multiplier for the given scene. */
export function getUiScale(scene: Phaser.Scene): number {
  const { width, height } = readDisplaySize(scene);
  return computeUiScale(width, height, {
    designWidth: scene.scale.width,
    designHeight: scene.scale.height,
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
  const widthFit = (scene.scale.width - margin * 2) / contentWidth;
  const heightFit = (scene.scale.height - margin * 2) / contentHeight;
  const capped = Math.min(desired, widthFit, heightFit);
  return Math.max(1, Math.round(capped * 100) / 100);
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
