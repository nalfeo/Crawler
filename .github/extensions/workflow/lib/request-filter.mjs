/**
 * Pure filtering for the Briefs tab request list.
 *
 * @param {Array<object>} items
 * @param {string} stage
 * @param {string} query
 * @returns {Array<object>}
 */
export function filterWorkflowItems(items, stage, query) {
  var needle = String(query || '')
    .trim()
    .toLowerCase();
  return (items || []).filter(function (item) {
    if (!item) return false;
    if (stage && stage !== 'all' && item.stage !== stage) return false;
    if (!needle) return true;
    return [item.name, item.id, item.requestedType, item.stage].some(function (value) {
      return (
        String(value || '')
          .toLowerCase()
          .indexOf(needle) >= 0
      );
    });
  });
}
