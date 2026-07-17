# Handoff: CI review-wake recovery follow-up

## Date

2026-07-17

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3 apples estimated and actual - two trust-boundary fixes plus deterministic regression coverage and one stale CI expectation update.

## What changed

- `review-wake-bridge.mjs` now derives the immutable merge base between the
  reviewed `run.head_sha` and the default branch, then compares every protected
  recovery-workflow blob at the run head against that merge-base snapshot
  instead of today's default-branch blobs. This keeps stale PR branches
  eligible while still failing closed on branch-authored router/recovery
  workflow edits.
- `reconcile.mjs` now treats any value other than `draft: false` as outside the
  bridge-started expected-metadata contract, so a PR converted to draft after
  the opening fetch fails closed before any mutation phase.
- Added deterministic regressions for both cases: a stale-branch bridge accept
  path keyed to merge-base-equal protected blobs, and a same-head draft
  conversion race that must skip before `acquire-label`.
- Scoped trusted base metadata to bridge-bound test fixtures, preserving the
  established direct-reconciliation state fingerprints.
- Updated `docs/guides/ci-recovery.md` so the trust-boundary documentation
  matches the merge-base protected-workflow policy.

## Validation

- Independent complete-diff review via a separate `gemini-3.1-pro-preview`
  code-review agent: no concerns.
- Full CI recovery script suite: 148 tests total, 111 passed and 37 known
  Windows subprocess-shutdown skips.
- Recovery workflow wiring and router-title Vitest suite: 7/7.
- `npm run verify:pr-prereqs`
- `npm run verify:fast`

## Review-thread status

- `review-wake-bridge.mjs`: the stale-branch reviewer concern is addressed by
  merge-base-scoped protected-workflow comparison plus deterministic stale-PR
  coverage.
- `reconcile.mjs`: the draft-transition reviewer concern is addressed by adding
  draft to the expected-metadata fence plus a before-first-mutation race test.
