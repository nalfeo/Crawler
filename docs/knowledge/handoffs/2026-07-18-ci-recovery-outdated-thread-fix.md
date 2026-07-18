# Handoff: CI recovery — stabilize review-thread blocker fingerprint

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Fixed a deterministic fingerprint-instability defect in the CI recovery reconciler that caused
spurious attempt-counter resets on outdated review threads. The primary fix (`reconcile.mjs`)
removes the `line` field from review-thread blockers; `thread.line` changes from a number to `null`
as GitHub ages outdated threads, causing the fingerprint to change and resetting the attempt
counter. Thread identity is already stable via `reviewThreadBlockerId` (thread ID + comment
digest), so `line` was redundant and only introduced instability.

A secondary initial change (auto-resolving `isOutdated` threads) was evaluated by a different-model
validator during code review and reverted: `isOutdated` only means GitHub can no longer map the
thread to the current diff; it does NOT prove the underlying concern is resolved. ADR 0058 DEC-008
permits auto-resolution only for "marker-confirmed fixes or deterministic non-applicability" — and
the `isOutdated` flag alone does not meet that bar.

## Root cause

**Fingerprint instability**: Review-thread blockers included `line: thread.line` in the normalized
fingerprint. For outdated threads, GitHub changes `line` from a number to `null` over time,
causing the fingerprint to change and `automationStallAction` to interpret it as "progress",
resetting the attempt counter and granting extra dispatch slots — even though the blocker had not
actually changed.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs` — review-thread blocker omits `line` to prevent
  fingerprint instability
- `.github/scripts/ci-recovery/state.mjs` — `shouldResolveThread()` reverted to require trusted
  marker only (no `isOutdated` auto-resolve); updated JSDoc to explain the `isOutdated` non-applicability
- `.github/scripts/ci-recovery/state.test.mjs` — corrected tests: `isOutdated` alone does not
  auto-resolve; added fingerprint-stability regression test; outdated thread with trusted marker still resolves
- `docs/knowledge/review-ledgers/2026-07-18-ci-recovery-outdated-thread-fix.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-18-ci-recovery-outdated-thread-fix.md`

## What changed

- Review-thread blocker construction in `reconcile.mjs` no longer sets the `line` field, so
  fingerprints are stable regardless of GitHub API returning null for aged outdated threads.
- `shouldResolveThread()` in `state.mjs` requires a trusted `✅ Addressed in <sha>` marker;
  `isOutdated` alone does not trigger auto-resolution.
- Five regression tests: outdated thread without marker stays blocked; outdated thread with
  substantive reviewer concern stays blocked; outdated thread WITH trusted marker resolves;
  non-outdated thread without marker stays blocked; fingerprint stability across `line: 93 → null`.

## Observe before done

This change is infrastructure/automation-only. Observable effect: on the next CI recovery run for
a PR with an outdated review thread, the fingerprint will no longer change when GitHub nulls out
the `line` field, preventing spurious attempt-counter resets. The thread will remain a stable
blocker until a trusted `✅ Addressed in <sha>` marker is posted.

## Verification run

- `node --test .github/scripts/ci-recovery/state.test.mjs` — 36 tests, all pass (5 new)
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` — passing
- `npm run verify:fast` — all passing (unshallowed clone resolves the prior epic-status.test.ts git-history miss)

## Recommended next steps

- For PR #1524: a Copilot repair session must post `✅ Addressed in <sha>` markers to the outdated
  review threads before they can be auto-resolved, OR a human reviewer must resolve them manually.
- Monitor CI recovery logs to confirm attempt counters are stable across reconciliation cycles.
