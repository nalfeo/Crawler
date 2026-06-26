/**
 * render-scale — HiDPI supersampling for crisp text and pixel art on
 * high-resolution displays.
 *
 * The game is authored against a fixed 1280×720 *design space* and uses
 * `Phaser.Scale.FIT`, which nearest-neighbour upscales the canvas backing store
 * to the display. Phaser 4 sizes that backing store to the design size with no
 * `devicePixelRatio` multiply, so on a HiDPI screen every glyph is rasterised at
 * 720p and then stretched across ~1.5–2× as many physical pixels — the cause of
 * blurry HUD text.
 *
 * The fix is to render the whole game into a `design × S` framebuffer (where `S`
 * is an integer *render scale*) while keeping the 1280×720 design space for all
 * gameplay, layout and input via camera zoom. `S` is derived once at boot from
 * how magnified the canvas actually is on screen (`FIT magnification × dpr`).
 *
 * Crucially, on a 1× display at/below the design size `S === 1`, so the whole
 * mechanism is a no-op (no extra fill-rate cost, and CI/e2e — which run at
 * `devicePixelRatio: 1` — are unaffected).
 *
 * Engine layer only (Phaser allowed). No imports from core/game/labs.
 */
import type Phaser from 'phaser';
import { GAME } from '../shared/constants.js';

/**
 * Upper bound on the supersample render scale.
 *
 * `2` renders into at most a 2560×1440 framebuffer (4× the fill rate of 720p),
 * which fully covers the common `devicePixelRatio: 2` case and large 1× displays
 * shown at 2× magnification. Higher-density displays (dpr 3 phones, 8K panels)
 * are capped here to bound GPU cost; the residual is far sharper than the 720p
 * baseline. Tunable if profiling shows headroom.
 */
export const MAX_RENDER_SCALE = 2;

export interface ComputeRenderScaleOptions {
  /** Design width the game is authored against. Defaults to GAME.WIDTH. */
  readonly designWidth?: number;
  /** Design height the game is authored against. Defaults to GAME.HEIGHT. */
  readonly designHeight?: number;
  /** Largest allowed render scale. Defaults to {@link MAX_RENDER_SCALE}. */
  readonly max?: number;
}

/**
 * Pure: the integer supersample scale `S` for a canvas displayed at
 * `displayWidthCss × displayHeightCss` CSS pixels on a `devicePixelRatio` display.
 *
 * `min(displayW/designW, displayH/designH)` is the `Phaser.Scale.FIT`
 * magnification (how many CSS pixels each design pixel covers on its tightest
 * axis); multiplying by `devicePixelRatio` converts that to physical pixels per
 * design pixel — i.e. how much detail the framebuffer needs to carry to avoid
 * upscaling. The result is rounded to the nearest integer (so the framebuffer
 * stays an integer multiple of the design size — required for crisp pixel-art
 * scaling) and clamped to `[1, max]`.
 *
 * Degenerate/pre-layout sizes fall back to `1` (the no-op baseline).
 */
export function computeRenderScale(
  displayWidthCss: number,
  displayHeightCss: number,
  devicePixelRatio: number,
  options: ComputeRenderScaleOptions = {},
): number {
  const designWidth = options.designWidth ?? GAME.WIDTH;
  const designHeight = options.designHeight ?? GAME.HEIGHT;
  const max = options.max ?? MAX_RENDER_SCALE;
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;

  if (!(displayWidthCss > 0) || !(displayHeightCss > 0)) {
    return 1;
  }

  const fitMagnification = Math.min(displayWidthCss / designWidth, displayHeightCss / designHeight);
  const physicalPerDesign = fitMagnification * dpr;
  const rounded = Math.round(physicalPerDesign);
  return Math.min(max, Math.max(1, rounded));
}

/** Read `window.devicePixelRatio`, falling back to 1 outside a DOM context. */
export function readDevicePixelRatio(): number {
  if (typeof window !== 'undefined' && window.devicePixelRatio > 0) {
    return window.devicePixelRatio;
  }
  return 1;
}

/**
 * The live render scale `S` for a scene, recovered from the game size the config
 * was booted with: the canvas is sized `design × S`, so `S = scale.width / designW`.
 *
 * Returns `1` when the game is sized at (or below) the design width — the no-op
 * baseline used on 1× displays and in headless/lab scenes that boot at the design
 * size.
 */
export function getRenderScale(scene: Phaser.Scene): number {
  const ratio = scene.scale.width / GAME.WIDTH;
  if (!(ratio >= 1)) {
    return 1;
  }
  return Math.round(ratio);
}

/**
 * Boot helper: the supersample scale for a parent container, read from its
 * laid-out CSS size (falling back to the window viewport, then the design size).
 *
 * Call this *before* constructing the Phaser game so the canvas can be sized
 * `design × S`. The parent element has already been laid out by the time the
 * boot module script runs, so `clientWidth/Height` reflect its on-screen size.
 */
export function resolveBootRenderScale(
  parent: string | HTMLElement | null | undefined,
  options: ComputeRenderScaleOptions = {},
): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return 1;
  }
  const element = typeof parent === 'string' ? document.getElementById(parent) : (parent ?? null);
  const cssWidth = element?.clientWidth || window.innerWidth || GAME.WIDTH;
  const cssHeight = element?.clientHeight || window.innerHeight || GAME.HEIGHT;
  return computeRenderScale(cssWidth, cssHeight, readDevicePixelRatio(), options);
}
