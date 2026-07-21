/**
 * run-filter.mjs — pure text-filter model for the Runs tab's run picker.
 *
 * The picker already had a promotion `<select>` (all / promoted / not-promoted);
 * this adds a plain type-to-filter TEXT INPUT that narrows the SAME list by a
 * case-insensitive substring match against `briefId`/`runId`, composed with
 * (not replacing) the promotion filter. Kept as a pure, closure-free function so
 * it can be unit-tested directly and (like `slice-overlay.mjs`) serialized
 * verbatim into the client script via `Function.prototype.toString()` — no
 * hand-duplicated drift between the tested logic and what actually runs in the
 * iframe.
 *
 * Deliberately a plain text filter + the EXISTING native `<select>`, not a
 * bespoke combobox: a native `<input>`/`<select>` pair preserves standard
 * keyboard (Tab/Arrow/Enter) and screen-reader behavior for free.
 *
 * @module workflow/run-filter
 */

/**
 * @param {Array<{briefId:string, runId:string, promoted?:boolean}>} runs
 * @param {'all'|'promoted'|'not-promoted'} promotedFilter
 * @param {string} query
 * @returns {Array<object>}
 */
export function filterRuns(runs, promotedFilter, query) {
  var byPromotion = (runs || []).filter(function (r) {
    if (promotedFilter === 'promoted') return !!(r && r.promoted);
    if (promotedFilter === 'not-promoted') return !(r && r.promoted);
    return true;
  });
  var needle = (query || '').trim().toLowerCase();
  if (!needle) return byPromotion;
  return byPromotion.filter(function (r) {
    if (!r) return false;
    var briefId = String(r.briefId || '').toLowerCase();
    var runId = String(r.runId || '').toLowerCase();
    return briefId.indexOf(needle) >= 0 || runId.indexOf(needle) >= 0;
  });
}
