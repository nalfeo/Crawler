---
name: session-kickoff-closeout
description: >-
  Run Crawler's compact session kickoff and closeout workflow for implementation
  work, including preflight, scoped validation, handoff, and PR publication.
---

# Session kickoff / closeout

## Kickoff

1. Run `npm run preflight`.
2. State the recommendation verdict and select the owning persona.
3. Read only the relevant handoff-index entries and durable memory.
4. Confirm a measurable success gate when the request is underspecified.
5. Keep the implementation plan in session chat and PR context.

## Closeout

1. Run focused checks, then `npm run verify:fast`.
2. Apply the risk-based review trigger in `review-harness`.
3. Write one dated handoff with `## Systems touched`.
4. Run `npm run verify:pr-prereqs` and pre-publish main sync.
5. Publish a ready-for-review PR and release local ownership.

Investigation-only sessions without a landing fix may skip implementation
closeout. CI owns the full suite and handoff-index regeneration.
