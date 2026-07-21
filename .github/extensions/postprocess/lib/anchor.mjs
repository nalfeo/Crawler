/**
 * anchor.mjs — pure browser geometry for the manual-anchor picker.
 *
 * The postprocess debugger lets you click the FINAL output image to set a manual
 * hold anchor (in the final sprite's pixel space), and draws a marker back on the
 * image. Both directions are pure math with NO DOM/closure deps, so — exactly
 * like `lib/slice-overlay.mjs` — these functions are serialized verbatim into the
 * renderer's in-iframe client via `Function.prototype.toString()`; the SAME
 * unit-tested code runs in the browser (no hand-duplicated drift).
 *
 * Parity: the monolith final-image click handler maps a click to natural pixels
 * with `floor` + clamp to `[0, natural-1]` (`src/devtools-main.ts` ~5616-5657) and
 * positions the marker at `((coord + 0.5) / natural) * 100`% (center-of-pixel).
 *
 * @module postprocess/anchor
 */

/**
 * Map a click on the final image to an anchor pixel in the image's natural
 * coordinate space. Returns `null` when the geometry is unusable (zero-area rect
 * or non-positive natural dimensions) so the caller can ignore the click.
 *
 * @param {{clientX:number, clientY:number,
 *          rect:{left:number, top:number, width:number, height:number},
 *          naturalWidth:number, naturalHeight:number}} args
 * @returns {{x:number, y:number}|null}
 */
export function finalImageClickToAnchor(args) {
  if (!args || typeof args !== 'object') return null;
  const { clientX, clientY, rect, naturalWidth, naturalHeight } = args;
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const relX = (clientX - rect.left) / rect.width;
  const relY = (clientY - rect.top) / rect.height;
  const x = Math.max(0, Math.min(naturalWidth - 1, Math.floor(relX * naturalWidth)));
  const y = Math.max(0, Math.min(naturalHeight - 1, Math.floor(relY * naturalHeight)));
  return { x, y };
}

/**
 * Project an anchor pixel back to a percentage position over the rendered image
 * (center-of-pixel). Returns `null` for non-positive natural dimensions.
 *
 * @param {{x:number, y:number, naturalWidth:number, naturalHeight:number}} args
 * @returns {{leftPct:number, topPct:number}|null}
 */
export function anchorMarkerPercent(args) {
  if (!args || typeof args !== 'object') return null;
  const { x, y, naturalWidth, naturalHeight } = args;
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    leftPct: ((x + 0.5) / naturalWidth) * 100,
    topPct: ((y + 0.5) / naturalHeight) * 100,
  };
}

/**
 * Select the center pixel using the same floor policy as a click exactly halfway
 * across the rendered image. Even dimensions choose the lower/right center pixel.
 *
 * @param {{naturalWidth:number, naturalHeight:number}} args
 * @returns {{x:number, y:number}|null}
 */
export function middleAnchor(args) {
  if (!args || typeof args !== 'object') return null;
  const { naturalWidth, naturalHeight } = args;
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return null;
  return {
    x: Math.min(naturalWidth - 1, Math.floor(naturalWidth / 2)),
    y: Math.min(naturalHeight - 1, Math.floor(naturalHeight / 2)),
  };
}
