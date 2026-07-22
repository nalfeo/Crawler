# Handoff: CI Recovery dispatch ordering — CI-fix first, blocked-PR exclusion, global FIFO

## Summary

Replaced the flag-off `collectPrNumbers` schedule/workflow_dispatch ordering with a
strict tiered sort that matches the acceptance criteria in issue #1775:

1. **Blocked PRs are excluded unconditionally** (even event-named): any PR carrying
   `ci-conflict-order-wait`, `ci-conflict-escalation`, `merge-train-blocked`,
   `merge-train-validation-failed`, `human-approval-required`, or
   `ci-recovery-waiting` is removed before the budget slice.
2. **CI-fix PRs (tier 2)** — detected by label (`ci` or `ci-infra`) — are dispatched
   before all general-purpose PRs, oldest-first within the tier.
3. **All other eligible PRs (tier 3)** follow oldest-first (global FIFO by `created_at`),
   replacing the previous rotation-window anti-starvation approach.
4. **Directly-triggered PRs (tier 1)** remain first, but blocked-PR exclusion takes
   precedence even over direct trigger.

Removed the rotation-based fairness mechanism (`rotateList`, `FLAG_OFF_SWEEP_ROTATION_WINDOW_MS`)
and the train-label prioritization (`TRAIN_OWNED_LABELS`, `hasTrainOwnedLabel`) which
were the previous anti-starvation approach.

## Files touched

- `.github/scripts/ci-recovery/router.mjs`
- `.github/scripts/ci-recovery/router.test.mjs`

## Systems touched

ci-recovery

## Key design decisions

- **Inline string literals for ci-conflict labels**: `ci-conflict-order-wait` and
  `ci-conflict-escalation` are defined in `ci-conflict-coordinator/state.mjs`, which
  is outside `router.mjs`'s trusted execution boundary (enforced by the
  `protected paths` test in `review-wake-bridge.test.mjs`). Used inline literals with
  comments instead of expanding the boundary.
- **`now` parameter removed from flag-off path**: the flag-off ordering no longer needs
  the current timestamp (rotation was removed). The `now` parameter is kept in the
  function signature for backward compatibility and the train-active path still uses it.
- **`merge-train-blocked` is excluded, not prioritized**: the previous code prioritized
  these PRs for flag-off cleanup. The new code follows the issue spec and excludes them,
  accepting that cleanup via the schedule sweep no longer applies to blocked PRs.

## Verification run

- `npm run test:guards` — 8 failures (all pre-existing; no new failures)
- `node --check .github/scripts/ci-recovery/router.mjs` — syntax OK

## Unresolved / next steps

- **Flag-off cleanup for `merge-train-blocked` PRs**: these are now excluded from
  dispatch. If they need cleanup, it must happen via a directly-triggered event (not
  a schedule sweep). A follow-up issue may be needed to address stale cleanup.
- **Dynamic `now` parameter**: the `now` parameter signature is kept but no longer used
  in the flag-off path. A future cleanup could remove it from the non-train path (minor).
