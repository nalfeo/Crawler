# Session Handoff: CI Recovery Comment Cleanup

## Date

2026-08-17

## Persona

DevOps Engineer

## Systems touched

ci-recovery

## Apples

Estimated 3🍎, actual 3🍎 (exact). The work stayed within the existing recovery
renderer and its focused subprocess regression suite.

## What changed

- Recovery task comments now render only applicable phases in recovery order and
  list their blockers in that same order.
- Aggregate `ci` and `Merge gate` failures are omitted when a concrete,
  actionable check also failed; advisory and self-recovery filtering remains
  unchanged.
- Review-thread instructions were condensed while retaining independent-model
  validation, deterministic non-applicability, post-push marker, and no
  top-level-reply requirements. Prior-recovery instructions appear only when a
  listed thread carries that hint.

## Validation

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run lint -- --max-warnings=0`

## Follow-up

No same-PR/same-fingerprint duplicate-dispatch change was made. Existing
per-PR workflow concurrency (`crawler-ci-pr-${pr_number}`) serializes runs and
the terminal dispatch table already suppresses a matching active automation
fingerprint. A future fix would need a reproduced bypass of those two contracts
before changing ownership/fence behavior.
