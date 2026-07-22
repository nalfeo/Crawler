/**
 * brief-lookup.mjs — pure "which brief file backs this run's View Brief
 * button" resolution.
 *
 * `state.files.briefs` enumerates every brief under `briefs/**` (draft AND
 * committed) with only a basename-derived `name`/id — two files (one draft,
 * one committed) can share the SAME basename (e.g. `briefs/draft/goblin.yaml`
 * and `briefs/goblin.yaml` both have id `goblin`). A basename-only lookup
 * therefore cannot tell them apart and may open the WRONG file for a run.
 *
 * The run's own summary.json records the EXACT repo-relative `briefPath` it
 * was generated from (plumbed through to `state.selected.briefPath` by
 * extension.mjs's `liveBuildState`), so `resolveBriefEntry` prefers an exact
 * `relPath` match against that value and only falls back to the ambiguous
 * basename match when no exact path is available (e.g. an older run summary
 * predating this field, or a summary fetch that failed). Either way the
 * returned entry always comes from the SAME already-allowlisted
 * `state.files.briefs` listing — this never introduces a new path the
 * extension's `/api/brief` route wouldn't otherwise allow.
 *
 * Self-contained (no imports/closures) so `Function.prototype.toString()`
 * yields a runnable declaration for `renderer.mjs` to splice into the browser
 * client script — same pattern as `lib/feedback-summary.mjs` etc.
 *
 * @module workflow/brief-lookup
 */

/**
 * @param {Array<{relPath: string, name: string}>} briefs
 * @param {string} relPath
 * @returns {{relPath: string, name: string} | null}
 */
export function findBriefEntryByPath(briefs, relPath) {
  var list = briefs || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].relPath === relPath) return list[i];
  }
  return null;
}

/**
 * @param {Array<{relPath: string, name: string}>} briefs
 * @param {string} briefId
 * @returns {{relPath: string, name: string} | null}
 */
export function findBriefEntryByBasename(briefs, briefId) {
  var list = briefs || [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].name === briefId) return list[i];
  }
  return null;
}

/**
 * Resolve the exact brief file entry for a selected run: an exact
 * `briefPath` match wins whenever available; the ambiguous basename match is
 * only used as a fallback.
 * @param {{files?: {briefs?: Array<{relPath: string, name: string}>}}} state
 * @param {{briefId: string, briefPath?: string | null} | null} sel
 * @returns {{relPath: string, name: string} | null}
 */
export function resolveBriefEntry(state, sel) {
  if (!sel) return null;
  var briefs = (state && state.files && state.files.briefs) || [];
  if (sel.briefPath) {
    var exact = findBriefEntryByPath(briefs, sel.briefPath);
    if (exact) return exact;
  }
  return findBriefEntryByBasename(briefs, sel.briefId);
}
