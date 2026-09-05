# Session Handoff: Fix sprite workflow readiness

## Date

2026-09-05

## Persona

DevOps Engineer

## Systems touched

sprite-pipeline, sprite-workflow, devtools

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact — the tooling cap matched the cross-extension readiness and canvas regression scope).

## What Was Done

- Fixed managed sprite-sidecar startup so readiness follows the service contract (`status`, repository, and version) rather than requiring the intentionally opt-in Azure worker and issue ingester to consume queues.
- Centralized the client readiness predicate for Workflow, Postprocess, and Storage, including a deterministic check that its expected version matches the server contract.
- Added regressions for managed service reuse/startup and the exact Workflow false-down/zero-runs case with healthy idle controllers and mirrored runs.
- Made the Workflow run review contract explicit: selected sheets and processed candidates render as static images in a review sheet/grid, never as animation.
- Preserved loopback-only discovery, repository/version/provenance validation, managed registry ownership, token-authenticated shutdown, and Azure-default fail-closed startup.
- Observed in the real managed Workflow canvas — before: raw `/api/health` was healthy while Workflow showed DOWN with zero runs and the launcher timed out; after: `npm run sprites:gallery` reused the healthy managed sidecar, Workflow showed UP with 233 mirrored runs, and the selected 16-candidate run rendered as a static source sheet and variant grid.

## Key Decisions Made

- Controller activity is operational state, not base service readiness: local consumers remain idle by default so they cannot race CI for the production Azure queue.
- All extension clients share one readiness predicate to prevent another copied contract from recreating the false-down state.
- The client-side expected version remains independently consumable by Node extensions, with a regression tying it to the TypeScript server contract.

## What's Next / Blockers

No implementation blockers remain. CI and the merge train own post-publication validation and landing.

## Retrospective

### Lessons Learned

An HTTP 200 health response was insufficient evidence because each client applied a stricter copied predicate afterward. Tracing the normalized canvas state across every sidecar consumer exposed the contract drift.

### Mistakes Made

The first implementation fixed Workflow and the manager but missed equivalent copied predicates in Postprocess and Storage. Independent review found both; searching all extension clients for the version constant and strict predicate would have surfaced them in the initial pass.

### Opportunities for Future Improvement

If extension TypeScript interop becomes standardized, move the service version into a directly shared typed module and replace the source-level consistency test with a normal cross-module import assertion.
