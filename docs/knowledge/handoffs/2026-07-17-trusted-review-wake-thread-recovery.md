# Handoff: trusted-review-wake thread recovery

**Date:** 2026-07-17
**Persona:** DevOps Engineer
**Apples:** estimated 2🍎 / actual 2🍎

## Systems touched

ci-policy

## Summary

Recovered the remaining PR #1227 review blockers by extending the trusted bridge's
immutable `.github/` subtree fence and hardening the targeted auto-rebase workflow
against shell-source injection and same-head metadata drift before push.

## Files touched

- `.github/scripts/ci-recovery/review-wake-bridge.mjs`
- `.github/scripts/ci-recovery/review-wake-bridge.test.mjs`
- `.github/workflows/auto-rebase-prs.yml`
- `tests/unit/ci-recovery-auto-rebase-wiring.test.ts`
- `docs/knowledge/review-ledgers/2026-07-17-trusted-review-wake-thread-recovery.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-17-trusted-review-wake-thread-recovery.md`

## What changed

- Added immutable `.github/scripts` and `.github/actions` subtree comparisons to
  the review-wake bridge so branch-authored privileged script or local-action
  changes fail closed before recovery dispatch.
- Added focused bridge regressions for modified `scripts` and `actions` subtrees,
  and exercised generic subtree snapshot lookup alongside the existing workflow
  tree checks.
- Stopped interpolating `workflow_dispatch` inputs directly into the auto-rebase
  shell source by routing `pr_number`, `expected_head_sha`, and
  `expected_base_ref` through step environment variables first.
- Added an immediate live PR metadata recheck before `git push --force-with-lease`
  on the successful targeted auto-rebase path so same-head draft/base/repository
  drift skips mutation instead of pushing stale intent.
- Added wiring assertions that pin the new env handoff and the pre-push metadata
  recheck in `auto-rebase-prs.yml`.

## Review validation

- Separate-model validation (`gpt-5.6-luna`) confirmed all three live review
  findings were still applicable before the fix:
  1. privileged `.github/scripts` / `.github/actions` code remained outside the
     bridge fence,
  2. targeted auto-rebase inputs were interpolated into shell source, and
  3. the successful rebase path lacked a pre-push metadata recheck.

## Verification run

- `node --test .github/scripts/ci-recovery/review-wake-bridge.test.mjs` ✅
- `npx vitest run tests/unit/ci-recovery-review-wake-bridge.test.ts tests/unit/ci-recovery-auto-rebase-wiring.test.ts` ✅
- `npm run verify:fast` ✅

## Unresolved issues

- None for this recovery slice.
