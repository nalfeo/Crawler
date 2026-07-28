# 2026-07-28 sweep-budget externally-blocked latent demand fix

## Systems touched
ci-recovery, merge-train

## What happened

CI failure on `main` at commit `dba6ed5b973aadb385c89bd5860970ec650bdd2a` (sprite asset
reconcile PR #2137). Two tests in `.github/scripts/sweep-budget.test.mjs` failed:

1. `latent backlog deduplicates merge-train and recovery demand by PR number` — expected 3, got 2
2. `latent backlog counts externally-blocked PRs once as latent demand` — expected 1, got 0

## Root cause

`countLatentBacklog` in `sweep-budget.mjs` only counted PRs from `queueEntries` and
`recoveryBacklogEntries`. Neither includes PRs with `merge-train-blocked` (or other
`EXTERNALLY_BLOCKED_LABEL_NAMES` labels): `queueEntries` excludes them via `BLOCKED_LABEL`,
and `eligibleTrainRecoveryPulls` (used by `recoveryBacklogEntries`) excludes them via
`isExternallyBlocked`. So externally-blocked PRs produced a count of zero even though the
tests specify they must contribute to the sweep budget's latent demand.

## Fix

- Imported `isExternallyBlocked` from `./ci-recovery/router.mjs` in `sweep-budget.mjs`
- Added a loop in `countLatentBacklog` that adds any PR that is open, non-draft, base=main,
  same repo, no `ci-recovery-opt-out`, and `isExternallyBlocked` to the latent-backlog Set

Deduplication is handled by the `Set`, so no PR can be counted twice.

## Verification

- `node --test .github/scripts/sweep-budget.test.mjs`: 10/10 pass (was 8/10)
- `npm run verify:fast`: 115 test files, 1719 tests — all pass
