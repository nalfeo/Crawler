# Session Handoff: Landed resolver association edge

## Date

2026-07-15

## Persona

Producer / DevOps Engineer

## Systems touched

ci-policy

## Apples

2 apples declared, 2 actual (exact) -- one shared resolver, a focused
deterministic test suite, and documentation corrections.

## What Was Done

- Extracted `resolveLandedPr` from the CLI wrapper so its GitHub responses can be
  tested deterministically.
- Preserved the durable mapping order: a corroborated `Merge-Train-PR` trailer
  remains first, followed by GitHub's exact `merge_commit_sha` record.
- Replaced the arbitrary `pulls[0]` fallback with a deterministic open-head
  match (`state === 'open'` and `head.sha === requested SHA`), ordered by PR
  number if GitHub supplies duplicate open-head associations. Closed or merged
  associations without an exact merge record are no longer misattributed.
- Added resolver regressions for trailer priority, exact merge-record priority,
  simultaneous closed/merged and open-head associations, clean no-match, and
  API failure. `deploy.yml`'s released/baseline-sweep comment and
  `manual-preview.yml` both consume this resolver, so their attribution remains
  centralized.
- Corrected ADR 0063, the merge-train guide, and the source handoff: recovery
  only resumes automatically after the durable `merge-train-landed`
  proof-complete marker exists. A crash after proof but before that marker stays
  queued for human review.

## Safety Boundaries Preserved

- `MERGE_TRAIN_ENABLED` remains `false`.
- No protection, ruleset, workflow permission, or promotion behavior changed.
- The resolver still returns exit 3 for an unrecoverable API failure and empty
  exit 0 for a genuine no-match.

## Verification

- `node --test .github/scripts/merge-train/resolve-landed-pr.test.mjs`
- `npm run verify:fast`
