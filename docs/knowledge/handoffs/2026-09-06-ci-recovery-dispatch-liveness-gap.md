# 2026-09-06 — CI Recovery: allow stale blocked PRs to redispatch

## Systems touched: ci-policy

## Summary

Fixed the CI-recovery liveness backstop so a stale blocked PR is not permanently fenced by no-op decision records such as `skip-duplicate-fingerprint`, `skip-merge-train-owned`, `queue-merge-train`, or `wait-admission`. Those actions are normal reconcile outcomes, not active ownership signals, so the liveness sweep was incorrectly treating them as reasons to suppress the stale-PR redispatch that should reopen a dispatch window after four hours.

**Apple estimate:** 2🍎 (declared at kickoff). Actual: 2🍎.

**Verdict:** recommended. The issue defined a concrete success gate: no open blocked PR may remain stale beyond the 4h per-PR gap without a fresh `@copilot` dispatch from the 8h liveness sweep.

## Why it was happening

`protectedLivenessPullNumbers()` treated a wide set of no-op/terminal actions as if they were protecting an actively owned PR. When a blocked PR had only stale skip/no-op history and no successful dispatch in the liveness window, the backstop filtered it out before re-dispatch.

This created the exact incident signature in the issue: a blocked backlog with zero dispatches, but the code still protecting the stale PRs because last decision records were the wrong type of signal.

## What changed

- In `.github/scripts/ci-recovery/harvest-liveness.mjs`, narrowed `PROTECTED_LIVENESS_ACTIONS` to actual ownership / active-guard signals.
- Retained protection for real owner-aware blockers such as active shepherd ownership, active Copilot progress, conflict-order waits, conflict-rebase backoff, and terminal exhausted-automation states.
- Applied the same dispatch-eligibility predicate when the liveness sweep builds its monitored blocked backlog, so dirty, quarantined, merge-train-owned, or human-approval-gated PRs do not produce an incident that cannot redispatch them.
- Added deterministic regression coverage for the stale no-op case and the reported dirty, labelled incident states.

## Verification

- `bash scripts/agent/verify-fast.sh` — passed.
- `node --test .github/scripts/ci-recovery/harvest-liveness.test.mjs` — passed.
- `npm run verify:pr-prereqs` — passed after adding this handoff file.

## Unresolved issues

None at the session boundary. The fix is scoped to the dispatch-liveness backstop and covered by the regression test.

## Recommended next steps

- Watch the next `ci-liveness-sweep` cycle for stale blocked PR redispatches.
- If the same incident recurs, verify the decision records are now a mix of real protection states and genuine dispatch traces rather than only stale no-ops.
