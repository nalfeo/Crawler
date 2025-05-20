# Handoff: CI recovery PR #1367 exhausted redispatch guard

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Investigated issue #1579 (CI recovery loop for PR #1367) and confirmed the reconciler could redispatch recovery after an exhausted stale-automation release when ownership had already been released (`owner=none`, `trigger=stale-automation-exhausted`) but head+blocker fingerprint had not changed. Added a guard to skip redispatch for that unchanged exhausted progress key.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-19-ci-recovery-pr1367-exhausted-redispatch.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-19-ci-recovery-pr1367-exhausted-redispatch.md`

## What changed

- Added `stale-automation-exhausted` redispatch suppression in `reconcile.mjs` when:
  - no owner label exists,
  - state is `owner=none`, `status=idle`, `trigger=stale-automation-exhausted`, and
  - persisted progress key matches current `(headSha, blockerFingerprint)`.
- Added regression test proving reconcile logs `skip ... reason=stale-automation-exhausted` and does not post a new recovery task comment in that scenario.

## Root-cause finding

The marker parser and trusted-thread resolution path are functioning as designed for in-thread `✅ Addressed` markers. The deterministic loop came from state transition behavior: after an exhausted release, subsequent sweeps with unchanged blocker progress could re-enter dispatch because there was no guard for already-exhausted unchanged progress when the owner label was absent.

## Verification run

- `node --test --test-name-pattern "stale-automation-exhausted|redispatch" .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-19-ci-recovery-pr1367-exhausted-redispatch.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- Could not post the required pre-coding plan comment to issue #1579 from this environment. `gh issue comment` and `gh api` issue-comment POST both returned `403` (blocked by DNS monitoring proxy).

## Recommended next steps

- If further investigation is needed, add a follow-up deterministic signal in loop incidents for top-level (non-thread) addressed-marker claims to speed operator diagnosis.
