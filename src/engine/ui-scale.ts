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

/**
 * Upper bound on screen-space text render resolution. Phaser rasterises text to
 * an internal glyph texture `resolution`× larger than its font size; capping the
 * value stops long HUD strings from allocating oversized textures on 4K / high-DPI
 * displays while still covering every realistic on-screen pixel density.
 */
export const MAX_TEXT_RESOLUTION = 4;

export interface ComputeTextResolutionOptions {
  /** Design width the canvas renders at before FIT scaling. Defaults to GAME.WIDTH. */
  readonly designWidth?: number;
  /** Design height the canvas renders at before FIT scaling. Defaults to GAME.HEIGHT. */
  readonly designHeight?: number;
  /**
   * Extra in-canvas scale a responsive container applies to the text (e.g. the
   * HUD corner groups that grow on small screens). Defaults to 1 (no container scale).
   */
  readonly responsiveScale?: number;
  /** Largest allowed resolution. Defaults to {@link MAX_TEXT_RESOLUTION}. */
  readonly max?: number;
}

/**
 * Pure: the glyph render resolution that keeps screen-space text crisp.
 *
 * The game renders at the design size and `Phaser.Scale.FIT` scales the whole
 * canvas to the display, so each design pixel covers
 * `min(displayW/designW, displayH/designH)` CSS pixels (the FIT magnification).
 * `devicePixelRatio` converts CSS pixels to physical pixels, and `responsiveScale`
 * accounts for HUD groups that additionally scale text up on small screens. The
 * dominant of the FIT magnification and the responsive scale, times DPR, is how
 * many physical pixels each design pixel spans — i.e. the resolution at which text
 * must be rasterised so it is not nearest-neighbour upscaled (the cause of blurry
 * HUD text). Rounded up (oversampling stays sharp; undersampling blurs) and clamped
 * to `[1, max]`.
 */
export function computeTextResolution(
  displayWidth: number,
  displayHeight: number,
  devicePixelRatio: number,
  options: ComputeTextResolutionOptions = {},
): number {
  const designWidth = options.designWidth ?? GAME.WIDTH;
  const designHeight = options.designHeight ?? GAME.HEIGHT;
  const responsiveScale = options.responsiveScale ?? 1;
  const max = options.max ?? MAX_TEXT_RESOLUTION;
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;

  // Degenerate sizes (pre-layout / headless): fall back to native resolution.
  if (!(displayWidth > 0) || !(displayHeight > 0)) {
    return 1;
  }

  const fitMagnification = Math.min(displayWidth / designWidth, displayHeight / designHeight);
  const onScreenScale = Math.max(fitMagnification, responsiveScale) * dpr;
  return Math.min(max, Math.max(1, Math.ceil(onScreenScale)));
}

/** Read `window.devicePixelRatio`, falling back to 1 outside a DOM context. */
function readDevicePixelRatio(): number {
  if (typeof window !== 'undefined' && window.devicePixelRatio > 0) {
    return window.devicePixelRatio;
  }
  return 1;
}

/**
 * Live screen-space text resolution for a scene (see {@link computeTextResolution}).
 * Combines the canvas FIT magnification, device pixel ratio, and the responsive
 * HUD scale so HUD text rasterises crisply at the current display size.
 */
export function getTextResolution(scene: Phaser.Scene): number {
  const { width, height } = readDisplaySize(scene);
  return computeTextResolution(width, height, readDevicePixelRatio(), {
    designWidth: scene.scale.width,
    designHeight: scene.scale.height,
    responsiveScale: getUiScale(scene),
  });
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
): () => void {
  let lastResolution = 0;
  const apply = (): void => {
    const resolution = getTextResolution(scene);
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
