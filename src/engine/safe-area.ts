/**
 * safe-area — display-cutout / home-indicator aware insets for screen-space UI.
 *
 * Crawler ships as a landscape-only web game. On a notched phone (the reference
 * target is an iPhone 13 Pro: 2532×1170 physical = 844×390 CSS px at DPR 3) the
 * browser reports the regions the system chrome covers via the CSS
 * `env(safe-area-inset-*)` values, but only once the document opts into
 * edge-to-edge layout with `viewport-fit=cover`.
 *
 * The HTML entry points re-publish those environment values as the custom
 * properties `--crawler-safe-area-inset-{top,right,bottom,left}` on `:root`.
 * Reading custom properties (rather than `env()` directly) keeps this module
 * testable: an e2e harness can inject a real device's insets on a desktop
 * browser — which always reports zero — with a single stylesheet override.
 *
 * The insets are published in CSS pixels relative to the *viewport*, while the
 * UI is laid out in the fixed 1280×720 design space of a `Phaser.Scale.FIT`
 * canvas. {@link computeDesignSafeInsets} bridges the two: it intersects each
 * unsafe band with the canvas rect and converts the overlap into design pixels.
 * That intersection matters — at 844×390 the 16:9 canvas is pillarboxed to
 * ~693×390, so the 47px notch band falls entirely inside the black bar and
 * costs the UI nothing, while the 21px home-indicator band covers the full
 * width of the canvas bottom and must be avoided.
 *
 * Engine layer only (Phaser allowed). No imports from core/game/labs.
 */
import type Phaser from 'phaser';
import { GAME } from '../shared/constants.js';

/** Same ScaleManager resize event name used by `ui-scale.ts` (see note there). */
const SCALE_RESIZE_EVENT = 'resize';

/** CSS custom property prefix the HTML entry points publish `env()` values to. */
const CSS_VAR_PREFIX = '--crawler-safe-area-inset-';

/** Inset distances from each edge. Units depend on the producer (CSS or design px). */
interface SafeAreaInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** No-inset value — the desktop case and the safe fallback everywhere else. */
const ZERO_SAFE_AREA_INSETS: SafeAreaInsets = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};

/** Axis-aligned rectangle in CSS pixels, as returned by `getBoundingClientRect`. */
export interface CanvasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ComputeDesignSafeInsetsOptions {
  /** Live canvas rect in CSS pixels, relative to the viewport. */
  readonly canvas: CanvasRect;
  /** Viewport size in CSS pixels. */
  readonly viewport: { readonly width: number; readonly height: number };
  /** Viewport-relative unsafe bands in CSS pixels. */
  readonly insets: SafeAreaInsets;
  /** Design width the UI was authored against. Defaults to `GAME.WIDTH`. */
  readonly designWidth?: number;
  /** Design height the UI was authored against. Defaults to `GAME.HEIGHT`. */
  readonly designHeight?: number;
}

/** Clamp to a finite, non-negative number (guards NaN / missing CSS values). */
function toPositive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Pure: how far each edge of the *design-space* UI must inset so nothing is
 * drawn underneath system chrome.
 *
 * Each unsafe band is intersected with the canvas rect first, so a band that
 * lies entirely in the letterbox/pillarbox contributes nothing. The surviving
 * overlap is then converted from CSS pixels to design pixels using the canvas's
 * own `design / displayed` ratio, and clamped to the design size so a
 * degenerate rect can never produce an inset that exceeds the canvas.
 */
function computeDesignSafeInsets(options: ComputeDesignSafeInsetsOptions): SafeAreaInsets {
  const designWidth = options.designWidth ?? GAME.WIDTH;
  const designHeight = options.designHeight ?? GAME.HEIGHT;
  const { canvas, viewport, insets } = options;

  // Pre-layout / headless: no canvas to intersect against, so nothing is unsafe.
  if (!(canvas.width > 0) || !(canvas.height > 0)) {
    return ZERO_SAFE_AREA_INSETS;
  }

  const scaleX = designWidth / canvas.width;
  const scaleY = designHeight / canvas.height;
  const canvasRight = canvas.x + canvas.width;
  const canvasBottom = canvas.y + canvas.height;

  // Overlap between the unsafe band at each viewport edge and the canvas.
  const leftOverlap = toPositive(insets.left) - canvas.x;
  const topOverlap = toPositive(insets.top) - canvas.y;
  const rightOverlap = canvasRight - (viewport.width - toPositive(insets.right));
  const bottomOverlap = canvasBottom - (viewport.height - toPositive(insets.bottom));

  const clampX = (overlap: number): number => Math.min(designWidth, Math.max(0, overlap) * scaleX);
  const clampY = (overlap: number): number => Math.min(designHeight, Math.max(0, overlap) * scaleY);

  return {
    top: clampY(topOverlap),
    right: clampX(rightOverlap),
    bottom: clampY(bottomOverlap),
    left: clampX(leftOverlap),
  };
}

/** Parse a CSS length that is already resolved to pixels (e.g. `"21px"`). */
function parsePx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Read the viewport-relative safe-area insets (CSS pixels) that the document
 * publishes as `--crawler-safe-area-inset-*`. Returns zeros when the properties
 * are absent (older entry point, non-browser env, or a device with no cutout).
 */
function readCssSafeAreaInsets(
  doc: Document | undefined = globalThis.document,
): SafeAreaInsets {
  if (!doc?.documentElement || typeof getComputedStyle !== 'function') {
    return ZERO_SAFE_AREA_INSETS;
  }
  const style = getComputedStyle(doc.documentElement);
  return {
    top: parsePx(style.getPropertyValue(`${CSS_VAR_PREFIX}top`)),
    right: parsePx(style.getPropertyValue(`${CSS_VAR_PREFIX}right`)),
    bottom: parsePx(style.getPropertyValue(`${CSS_VAR_PREFIX}bottom`)),
    left: parsePx(style.getPropertyValue(`${CSS_VAR_PREFIX}left`)),
  };
}

/**
 * Test-scaffolding exports: underscore-prefixed so guard scripts treat them as
 * intentional non-production API.
 */
export type _SafeAreaInsets = SafeAreaInsets;
export const _ZERO_SAFE_AREA_INSETS: SafeAreaInsets = ZERO_SAFE_AREA_INSETS;
export const _computeDesignSafeInsets = computeDesignSafeInsets;

/** Live canvas rect for a scene, or `null` when there is no laid-out canvas. */
function readCanvasRect(scene: Phaser.Scene): CanvasRect | null {
  const canvas = scene.game?.canvas;
  if (!canvas || typeof canvas.getBoundingClientRect !== 'function') {
    return null;
  }
  const rect = canvas.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * Current design-space safe-area insets for a scene. Zero on desktop, in
 * headless environments, and whenever the unsafe bands miss the canvas.
 */
export function getSafeAreaInsets(scene: Phaser.Scene): SafeAreaInsets {
  const canvas = readCanvasRect(scene);
  if (!canvas || typeof window === 'undefined') {
    return ZERO_SAFE_AREA_INSETS;
  }
  return computeDesignSafeInsets({
    canvas,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    insets: readCssSafeAreaInsets(),
    designWidth: GAME.WIDTH,
    designHeight: GAME.HEIGHT,
  });
}

/** True when two inset sets are equal (used to suppress no-op relayouts). */
function insetsEqual(a: SafeAreaInsets, b: SafeAreaInsets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/**
 * Subscribe to safe-area changes (rotation, resize, browser-chrome show/hide).
 * The callback does not fire on subscription — call {@link getSafeAreaInsets}
 * for the initial value. Returns an unsubscribe function.
 */
export function onSafeAreaChange(
  scene: Phaser.Scene,
  callback: (insets: SafeAreaInsets) => void,
): () => void {
  let last = getSafeAreaInsets(scene);
  const handler = (): void => {
    const next = getSafeAreaInsets(scene);
    if (!insetsEqual(next, last)) {
      last = next;
      callback(next);
    }
  };
  scene.scale.on(SCALE_RESIZE_EVENT, handler);
  return () => {
    scene.scale.off(SCALE_RESIZE_EVENT, handler);
  };
}
