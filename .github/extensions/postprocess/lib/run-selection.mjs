/**
 * run-selection.mjs — pure "which sheet is active" resolution shared by the
 * postprocess canvas's cold-open (`canvas.open` input) and live `select`
 * action/route paths.
 *
 * Extracted so a `canvas.open` input carrying an explicit `sheet` (added
 * alongside `briefId`/`runId`/`variantIndex`) is preselected deterministically
 * against a run's ACTUAL sheet list — falling back to the monolith's
 * `sheetFiles[len-1]` (last sheet) convention only when the requested sheet is
 * absent or doesn't exist on this run — and so that exact behavior is
 * unit-testable without needing the sidecar or the canvas-harness server.
 *
 * @module postprocess/run-selection
 */

/**
 * @param {string[]|null|undefined} sheets
 * @param {string|null|undefined} requestedSheet
 * @param {string|null} [fallbackSheet] explicit fallback; defaults to the last sheet
 * @returns {string|null}
 */
export function resolveActiveSheet(sheets, requestedSheet, fallbackSheet) {
  const list = Array.isArray(sheets) ? sheets : [];
  if (requestedSheet && list.includes(requestedSheet)) return requestedSheet;
  if (fallbackSheet !== undefined) return fallbackSheet;
  return list.length > 0 ? list[list.length - 1] : null;
}
