/**
 * Build the smallest parent-Workflow patch needed after Postprocess persistence.
 * Reset and apply-to-all affect the full run; a variant-scoped replace carries
 * only the selected candidate.
 */
export function buildPostprocessParentPatch({
  briefId,
  runId,
  mode,
  applyToAll,
  variantIndex,
  candidates,
}) {
  const allCandidates = Array.isArray(candidates) ? candidates : [];
  const scope = mode === 'reset' || applyToAll === true ? 'all' : 'variant';
  return {
    briefId,
    runId,
    scope,
    variantIndex: scope === 'variant' ? variantIndex : null,
    // Always include the full candidate list: repostprocessRun rebuilds every
    // summary entry (clearing sibling judge maps) even for a variant-scoped
    // reprocess, so all cards need the fresh data.
    candidates: allCandidates,
  };
}

export function parentSelectionMatches(selected, briefId, runId) {
  return selected?.briefId === briefId && selected?.runId === runId;
}
