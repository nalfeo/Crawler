# Handoff: Postprocess parent synchronization

## Date

2026-07-22

## Persona

Tools/DevEx implementation with browser QA.

## Systems touched

sprite-workflow, sprite-pipeline, devtools

## Apples

Estimated: 2

Actual: 2

## Summary

Successful embedded Postprocess Apply operations now update the visible parent
Workflow immediately. Variant scope replaces one candidate card; all-variant
scope replaces the full candidate section. Both paths preserve the exact iframe
DOM node and current run/variant selection.

The parent refresh reuses the sidecar's persisted-summary read-back and updates
the shared run-view cache. Explicit invalidation epochs prevent a background
revalidation started before persistence from overwriting the refreshed snapshot.

## Files touched

- `.github/extensions/postprocess/renderer.mjs`
- `.github/extensions/workflow/extension.mjs`
- `.github/extensions/workflow/renderer.mjs`
- `.github/extensions/workflow/lib/postprocess-parent-sync.mjs`
- `.github/extensions/workflow/lib/run-view-cache.mjs`
- matching Workflow/Postprocess extension tests

## Verification

- Workflow + Postprocess extension suites: 300 tests passed.
- `npm run verify:fast` passed.
- `npm run verify:pr-prereqs` passed before the follow-up branch was rebased onto
  merged `main`.
- Real Workflow canvas observation proved one-card and all-card replacement
  while retaining all 16 cards, the selected run, and the exact iframe node.
- A final extension reload repeated the variant-scoped proof against the
  persisted-summary cache update path.

## Unresolved issues

None.

## Recommended next steps

Let CI exercise the full merged-branch gate and merge the follow-up PR when
required checks pass.
