/**
 * request-filter.mjs — pure filter model for the Briefs tab's request picker.
 *
 * Mirrors `run-filter.mjs`'s shape exactly (a coarse `<select>` filter composed
 * with a plain type-to-filter text input), so the request list on Briefs and
 * the run list on Sprites behave consistently: same picker pattern, same
 * keyboard/screen-reader affordances, same "narrow, don't replace" semantics
 * for the search text.
 *
 * Kept as a pure, closure-free function so it can be unit-tested directly and
 * serialized verbatim into the client script via `Function.prototype.toString()`
 * (see `serializePureModule`/the `REQUEST_FILTER_FNS` splice in renderer.mjs) —
 * no hand-duplicated drift between the tested logic and what actually runs in
 * the iframe.
 *
 * Filtering NEVER drops the underlying `workflow.selectedId` — a filtered-out
 * selection simply doesn't appear in the rendered list; the caller is
 * responsible for leaving the detail panel showing the still-selected item.
 *
 * @module workflow/request-filter
 */

/**
 * @param {Array<{name?:string, kebabName?:string, requester?:string, stage?:string}>} items
 * @param {string} stageFilter 'all' or an exact `item.stage` value.
 * @param {string} query case-insensitive substring match over name/kebabName/requester.
 * @returns {Array<object>}
 */
export function filterRequests(items, stageFilter, query) {
  var byStage = (items || []).filter(function (item) {
    if (!stageFilter || stageFilter === 'all') return true;
    return !!(item && item.stage === stageFilter);
  });
  var needle = (query || '').trim().toLowerCase();
  if (!needle) return byStage;
  return byStage.filter(function (item) {
    if (!item) return false;
    var name = String(item.name || '').toLowerCase();
    var kebabName = String(item.kebabName || '').toLowerCase();
    var requester = String(item.requester || '').toLowerCase();
    return (
      name.indexOf(needle) >= 0 || kebabName.indexOf(needle) >= 0 || requester.indexOf(needle) >= 0
    );
  });
}
