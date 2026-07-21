/**
 * sheet-display.mjs — pure sizing math for the Runs tab sheet viewer's
 * constrained/full-size toggle.
 *
 * The sheet image DEFAULTS to a presentation constrained/scaled down to at
 * most 512x512px (never upscaled past its natural size), with a full-size view
 * option that shows the sheet at its natural pixel dimensions. This ONLY
 * affects the CSS display box — the underlying `<img>` src (and therefore the
 * asset's actual pixels) never changes between modes.
 *
 * Self-contained (no imports/closures) so `Function.prototype.toString()`
 * yields a runnable declaration for `renderer.mjs` to splice into the browser
 * client script — the SAME unit-tested code computes both the display size
 * and (by construction, since the overlay math already scales off
 * `img.clientWidth`) the overlay redraw on every toggle.
 *
 * @module workflow/sheet-display
 */

/**
 * @param {number} naturalWidth
 * @param {number} naturalHeight
 * @param {'constrained'|'full'} mode
 * @param {number} [maxSize] default 512
 * @returns {{width:number, height:number}}
 */
export function computeSheetDisplaySize(naturalWidth, naturalHeight, mode, maxSize) {
  var cap = typeof maxSize === 'number' && maxSize > 0 ? maxSize : 512;
  var w = naturalWidth > 0 ? naturalWidth : 0;
  var h = naturalHeight > 0 ? naturalHeight : 0;
  if (w === 0 || h === 0) return { width: 0, height: 0 };
  if (mode === 'full') return { width: w, height: h };
  // Constrained: scale down (never up) so BOTH dimensions fit within cap.
  var scale = Math.min(1, cap / w, cap / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}
