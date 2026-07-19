# Handoff: PR #1598 merge-conflict recovery

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-recovery

## Apples

Estimated 2🍎, actual 2🍎. Verdict: exact.

## Summary

Merged `origin/main` into `copilot/fix-ci-recovery-loop-1516` and resolved the only semantic conflict in `.github/scripts/ci-recovery/reconcile.mjs`.

- Preserved this branch's recovery note that the infrastructure resolves review threads after the `✅ Addressed in <sha>` marker is posted.
- Preserved `main`'s new guard that a top-level PR comment is never sufficient for a review-thread blocker.
- Kept the shared marker text centralized via `ADDRESSED_MARKER_REPLY`.
- Kept the matching regression coverage from `main` in `.github/scripts/ci-recovery/reconcile.test.mjs`.

## Validation

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Notes

- The repository was initially a shallow clone, so this session first ran `git fetch --unshallow origin` and `git fetch origin main:refs/remotes/origin/main` before merging, per repository policy.
- `files/guard-telemetry.jsonl` was absent, so no telemetry capture artifact was required for this session.
