# Handoff: Reconciler-controlled Copilot review gating

## Date

2026-07-22

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 3🍎, actual 3🍎.

## Summary

Replaced automatic Copilot re-review-on-every-push behavior with a reconciler-owned,
durable review budget. The GitHub ruleset remains responsible for the initial publish
review. CI Recovery records that review, then requests no more than two normal
re-reviews on distinct newer heads after required checks are green and all blockers are
clear. Each distinct merge-conflict episode receives one additional clean-and-green
review outside the normal budget.

## What changed

- Added strict trusted review-request and conflict-episode markers.
- Keyed conflict episodes by immutable head/base SHA pairs.
- Added marker-first request idempotency with rollback when reviewer mutation fails,
  including metadata-race exits.
- Reused the authoritative merge-train required-check admission result and fails closed
  when required checks are missing or not successful.
- Prevented managed review markers from recursively waking the recovery router.
- Added the new policy module to the trusted review-wake execution boundary.
- Removed `synchronize` and `review_requested` from the legacy ready/reviewer guard.
- Required reviewers to inspect prior resolved review history before reposting findings.

## Verification

- `node --test .github/scripts/ci-recovery/review-request.test.mjs .github/scripts/ci-recovery/review-wake-bridge.test.mjs`: 60/60 passing.
- `node --check` passed for the changed recovery scripts.
- `git diff --check`: clean.
- Review harness: 3🍎 plan review completed; two code-review rounds completed clean.
- Full npm validation could not run because the corporate package proxy returned 404
  for `fast-uri@3.1.4`; direct npm registry access was also blocked by TLS policy.

## Rollout

The active `Copilot code review` ruleset (ID `17252622`) still has
`review_on_push: true` so review coverage is not removed before this implementation
lands. After this PR merges, update the ruleset to `review_on_push: false`, preserving
the automatic initial publish review while making the reconciler the sole post-publish
review requester.
