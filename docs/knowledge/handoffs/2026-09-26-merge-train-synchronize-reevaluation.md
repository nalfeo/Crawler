## Date

2026-09-26

## Persona

DevOps

## Recommendation

Recommended: reconcile every same-repository pull request when its head changes,
including when a prior run left it without the `merge-train` label.

## Systems touched

- `.github/workflows/merge-train.yml`: admit same-repository
  `pull_request_target:synchronize` events to the serialized reconciliation job.
- `tests/unit/merge-train-workflow-wakeups.test.ts`: cover the stale
  `merge-train-blocked` label path and preserve the fork exclusion.

## Change summary

The workflow previously woke reconciliation for queue-label events but ignored a
same-repository `synchronize` event if self-admission had not yet restored the
`merge-train` label. A new commit can therefore leave stale train state behind.
The job gate now treats `synchronize` as a fresh-head wake-up, while retaining
the same-repository trust check and every existing workflow-run guard.

## Validation

- `npm test -- tests/unit/merge-train-workflow-wakeups.test.ts` (22 passing)
- `npm run typecheck:src`
- `git diff --check`
- `npm run scope`
- `npm run verify:fast`
- Fresh Ducky review of the implementation diff: no actionable findings.
- Independent second review of the implementation diff: no actionable findings.

## Retrospective

### Lessons

The workflow run had a precise event gate, but its label prerequisite made a
head update invisible during the interval before self-admission labels the PR
again. The head-update event is the authoritative freshness signal.

### Mistakes

No implementation mistakes identified.

### Opportunities

If merge-train state gets more complex, add an end-to-end fixture that drives a
head update through reconciliation rather than testing the workflow predicate
alone.
