# Static Workflow review UX

## Verdict

Recommended. The implementation extracts the static review surface onto current
main without replacing managed-sidecar readiness, durable workflow state, or
run-view caching.

## Apple estimate

3 apples.

## Changes

- Reorganized the canvas into Backlog, Briefs, and Sprites tabs.
- Added Briefs stage/search filtering, chosen-brief summary and disabled state,
  draft-safe rendering, and navigation back to Briefs.
- Kept the selected run as a static source-sheet and candidate-grid review
  surface with aspect-correct thumbnails.
- Added displayed-run force reprocess and judge actions with route validation,
  sidecar option forwarding, and targeted run-view invalidation.
- Preserved existing monotonic brief modal response protection and readiness,
  durability, and cache modules.

## Validation

Focused Workflow extension tests and `npm run verify:fast` pass.

## Systems touched

sprite-workflow, sprite-pipeline, devtools-extension-canvas, workflow-extension-test-harness
