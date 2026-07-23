# Handoff: Resume Workflow synchronization fix

## Date

2026-07-22

## Persona

Producer coordinating DevEx implementation, QA, and different-model review validation.

## Systems touched

sprite-workflow, sprite-pipeline, devtools

## Apples

Estimated: 3

Actual: 3

Exact: the recovery required stash triage, three concurrency/state fixes, focused
coverage, and full PR shepherding.

## Summary

Recovered PR #1763 without applying the dead session's named stash. The stash is
still intact because its generated manifest/catalog changes and quartermaster-cap
PNG belong to an unrelated asset workflow, while its untracked review ledger is an
incomplete scaffold for a broader cache/preview task.

The parent synchronization feature remains intact: successful embedded
Postprocess persistence immediately patches either one Workflow variant card or
the complete candidate section while preserving the selected run and exact iframe
DOM node.

The recovery hardens that behavior by:

- capturing per-key cache invalidation fences at operation start and applying the
  actual resolved run key to both cache writes and fresh-state notifications;
- reserving an epoch before explicit live refreshes and rebuilding from the
  current sheet context when selection or invalidation ownership changes;
- keeping persisted candidate-only parent patches separate from module-wide
  complete run-view cache snapshots;
- marking accepted in-place patches fresh and removing the stale revalidation
  badge.

## Runtime observation

Before the original parent-sync fix, successful Postprocess applies left Workflow
variant cards stale until a later refresh. The real Workflow canvas observation
recorded in `2026-07-22-postprocess-parent-sync.md` proved the corrected one-card
and all-card replacement paths while retaining all 16 cards, the selected run,
and the exact iframe node.

The recovery reproduced the newly reviewed races deterministically: an
invalidated completion that resolved from a guessed key to a different actual key
could still write and notify, a persisted candidate summary could be combined
with another instance's full cached view, and an accepted patch could leave the
stale badge visible. After the fix, focused extension coverage proves those
completions are fenced, candidate patches never synthesize shared full-view
entries, and accepted patches clear stale UI state without replacing the iframe
or selection.

## Review harness

Ledger:
`docs/knowledge/review-ledgers/2026-07-22-resume-workflow-sync-fix.review-ledger.json`

- Plan review (`gpt-5.4`): three concerns resolved; `plan_divergence: minor`.
- Code and exact-thread validation (`claude-sonnet-4.6`): all three PR findings
  addressed; no remaining high-confidence concerns.

## Validation

- Workflow + Postprocess extension suites: 338 tests passed.
- `npm run verify:fast` passed.
- The 3-apple review ledger validated.
- `npm run verify:pr-prereqs` passed.

## Blockers

None.
