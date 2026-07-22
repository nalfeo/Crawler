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
    candidates:
      scope === 'all'
        ? allCandidates
        : allCandidates.filter((candidate) => candidate?.index === variantIndex),
  };
}

export function parentSelectionMatches(selected, briefId, runId) {
  return selected?.briefId === briefId && selected?.runId === runId;
}
