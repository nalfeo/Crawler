# Handoff: Embed Postprocess in Sprite Generation Workflow

## Date

2026-07-21

## Persona

Tools/DevEx implementation with reviewer and browser QA validation.

## Systems touched

sprite-workflow, sprite-pipeline, devtools

## Apples

Estimated: 3

Actual: 3

## What changed

- Moved the full Postprocess Debugger into a persistent, initially-collapsed
  section at the bottom of Sprite Generation Workflow.
- Removed the standalone Postprocess canvas provider and the obsolete
  `project:postprocess` copy-link handoff.
- Kept one same-origin iframe alive outside Workflow's rerendered `#app` root.
  The first Open seeds its exact brief, run, sheet, and variant through the URL;
  later Opens retarget the same iframe.
- Moved the standalone Postprocess routes and versioned selection state under
  Workflow's `/postprocess/*` namespace while reusing Workflow's sidecar client,
  image cache, and startup owner.
- Preserved the full editor: source-sheet slicing, pipeline trace, live preview,
  tolerance controls, facing, manual anchor, reset, and persisted Apply changes.
- Added cache-first exact-context Postprocess state with one background
  revalidation and persistence-triggered invalidation.
- Added correlated ready reporting after every completed selection. Fast clicks
  before iframe readiness retarget the pending navigation; fast clicks after
  readiness coalesce to the latest selection without rendering stale responses.
- Kept persisted writes behind same-origin, mutation-token, JSON content-type,
  bounded-body, and server-side payload-rebuild guards.

## Runtime observation

Before the change, Open in Post-process Debugger could only expose a copied link
to a second canvas, and reopening an already-loaded context repeated the full
Azure-backed state load.

After reloading the real project extensions against the managed sidecar:

- only 11 providers loaded; the standalone Postprocess provider was absent;
- Workflow initially rendered no Postprocess iframe or request;
- a per-variant Open created one iframe with exact
  `briefId=iron-cleaver-v1`, run `2026-07-18T03-40-12-d4269ad7`,
  `variantIndex=0`, and `sheet=sheet-00.png`;
- the embedded editor exposed Refresh, Apply, Reset, Reset anchor, Reset to
  defaults, and Apply changes;
- reopening that warmed exact context reused the same iframe and reported ready
  in 39 ms;
- switching Workflow tabs did not replace the iframe;
- rapid variant 1 then variant 2 opens resolved to variant 2 rather than leaving
  the parent stuck on Loading;
- no Copy link controls remained.

## Review harness

Ledger:
`docs/knowledge/review-ledgers/2026-07-21-embed-postprocess-workflow.review-ledger.json`

- Plan review: six concerns resolved; `plan_divergence: minor`.
- Code review round 1: fixed the in-flight selection drop by coalescing rapid
  retargets to the latest context.
- Code review round 2: clean across correctness, security, cache/state ownership,
  iframe lifecycle, route parity, provider removal, and regression coverage.

## Validation

- Postprocess and Workflow Node extension suites passed.
- `npm run verify:fast` passed after the final race fixes.
- Real Workflow canvas behavior was observed through Chrome against the managed
  Azure sidecar.

## Blockers

None.
