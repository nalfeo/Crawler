/**
 * slice-overlay.mjs — pure geometry / selection / status helpers for the
 * postprocess debugger's sheet-slicing overlay.
 *
 * These mirror the monolith `drawSliceMapOnCanvas` math in `src/devtools-main.ts`
 * (`?page=postprocess`). They are intentionally PURE and self-contained (no
 * imports, no closures over module scope, only calls to each other) for two
 * reasons:
 *   1. They are unit-tested directly in Node (`tests/slice-overlay.test.mjs`).
 *   2. `renderer.mjs` serializes them via `Function.prototype.toString()` and
 *      injects the identical source into the browser client script, so the SAME
 *      tested code draws the overlay — no hand-duplicated drift.
 *
 * The canvas DRAW calls stay inline in the client script (they need a live 2d
 * context); everything decidable without a context lives here.
 *
 * @module postprocess/slice-overlay
 */

/**
 * Display scale for a sheet drawn at most `maxWidth` px wide (monolith uses 640).
 * @param {number} naturalWidth
 * @param {number} [maxWidth]
 * @returns {number}
 */
export function computeOverlayScale(naturalWidth, maxWidth) {
  var cap = typeof maxWidth === 'number' && maxWidth > 0 ? maxWidth : 640;
  if (!(naturalWidth > 0)) return 1;
  var maxW = Math.min(naturalWidth, cap);
  return maxW / naturalWidth;
}

/**
 * Rounded display dimensions for the whole sheet at a given scale.
 * @param {number} naturalWidth
 * @param {number} naturalHeight
 * @param {number} scale
 * @returns {{dw:number, dh:number}}
 */
export function computeDisplayDims(naturalWidth, naturalHeight, scale) {
  return { dw: Math.round(naturalWidth * scale), dh: Math.round(naturalHeight * scale) };
}

/**
 * Project a slice-map cell (natural px) into rounded display-space rect.
 * @param {{x0:number,y0:number,w:number,h:number}} cell
 * @param {number} scale
 * @returns {{dx:number, dy:number, dw:number, dh:number}}
 */
export function projectCell(cell, scale) {
  return {
    dx: Math.round(cell.x0 * scale),
    dy: Math.round(cell.y0 * scale),
    dw: Math.round(cell.w * scale),
    dh: Math.round(cell.h * scale),
  };
}

/**
 * Whether cell indices are authoritative. Matches monolith
 * `indicesTrustworthy = emptyCellsApplied !== false`.
 * @param {{emptyCellsApplied?:boolean}|null|undefined} sliceMap
 * @returns {boolean}
 */
export function indicesTrustworthy(sliceMap) {
  return !!sliceMap && sliceMap.emptyCellsApplied !== false;
}

/**
 * The selected cell for a variant, or null. Only trustworthy indices can select.
 * @param {{cells?:Array,emptyCellsApplied?:boolean}|null|undefined} sliceMap
 * @param {number} variantIndex
 * @returns {object|null}
 */
export function resolveSelectedCell(sliceMap, variantIndex) {
  if (!indicesTrustworthy(sliceMap)) return null;
  var cells = (sliceMap && sliceMap.cells) || [];
  for (var i = 0; i < cells.length; i++) {
    if (cells[i] && cells[i].index === variantIndex) return cells[i];
  }
  return null;
}

/**
 * Classify a cell for overlay styling: 'empty' | 'selected' | 'other'.
 * @param {{empty?:boolean,index?:number}} cell
 * @param {{emptyCellsApplied?:boolean}|null|undefined} sliceMap
 * @param {number} variantIndex
 * @returns {'empty'|'selected'|'other'}
 */
export function classifyCell(cell, sliceMap, variantIndex) {
  if (!cell || cell.empty) return 'empty';
  if (indicesTrustworthy(sliceMap) && cell.index === variantIndex) return 'selected';
  return 'other';
}

/**
 * Status line under the slicing overlay, byte-for-byte with the monolith.
 * @param {object|null|undefined} sliceMap
 * @param {number} variantIndex
 * @returns {string}
 */
export function buildSliceStatusText(sliceMap, variantIndex) {
  if (!sliceMap) return '';
  var cols = sliceMap.cols;
  var rows = sliceMap.rows;
  var cellW = sliceMap.cellW;
  var cellH = sliceMap.cellH;
  var rowOffsets = Array.isArray(sliceMap.rowOffsets) ? sliceMap.rowOffsets : [];
  var colOffsets = Array.isArray(sliceMap.colOffsets) ? sliceMap.colOffsets : [];
  var hasNudge = false;
  var i;
  for (i = 0; i < rowOffsets.length; i++) {
    if (rowOffsets[i] !== 0) {
      hasNudge = true;
      break;
    }
  }
  if (!hasNudge) {
    for (i = 0; i < colOffsets.length; i++) {
      if (colOffsets[i] !== 0) {
        hasNudge = true;
        break;
      }
    }
  }
  var nudgeNote = hasNudge
    ? ' \u00b7 autoNudge: rows[' + rowOffsets.join(',') + '] cols[' + colOffsets.join(',') + ']'
    : ' \u00b7 no nudge';
  var trustworthy = sliceMap.emptyCellsApplied !== false;
  var selectedCell = trustworthy ? resolveSelectedCell(sliceMap, variantIndex) : null;
  var cellLabel =
    selectedCell && !selectedCell.empty
      ? ' \u2014 variant #' +
        variantIndex +
        ' at (' +
        selectedCell.x0 +
        ',' +
        selectedCell.y0 +
        ') ' +
        selectedCell.w +
        '\u00d7' +
        selectedCell.h +
        'px'
      : '';
  var degradedNote = trustworthy
    ? ''
    : ' \u00b7 \u26a0 approximate slicing (brief unavailable) \u2014 cell indices not authoritative';
  return (
    cols +
    '\u00d7' +
    rows +
    ' grid \u00b7 ' +
    cellW +
    '\u00d7' +
    cellH +
    'px cells' +
    nudgeNote +
    cellLabel +
    degradedNote
  );
}

/**
 * Hit-test click coords (display px, canvas-relative) against non-empty cells.
 * `hitCells` entries carry the projected display rect for each cell.
 * @param {Array<{cell:object,x:number,y:number,w:number,h:number}>} hitCells
 * @param {number} x
 * @param {number} y
 * @returns {{cell:object,x:number,y:number,w:number,h:number}|null}
 */
export function hitTestCell(hitCells, x, y) {
  if (!Array.isArray(hitCells)) return null;
  for (var i = 0; i < hitCells.length; i++) {
    var e = hitCells[i];
    if (!e || !e.cell || e.cell.empty) continue;
    if (x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h) return e;
  }
  return null;
}

/**
 * Stale-response guard for live-postprocess: apply only the newest in-flight seq.
 * @param {number} seq   the seq the response was tagged with
 * @param {number} current  the latest seq issued by the client
 * @returns {boolean}
 */
export function shouldApplyResponse(seq, current) {
  return typeof seq === 'number' && seq === current;
}
