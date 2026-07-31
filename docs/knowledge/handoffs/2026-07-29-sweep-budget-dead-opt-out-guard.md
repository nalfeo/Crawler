# 2026-07-29 Remove dead ci-recovery-opt-out guard from countLatentBacklog

## Systems touched

ci-recovery, merge-train

## Problem

In `.github/scripts/sweep-budget.mjs`, `countLatentBacklog` added externally-blocked PRs
twice — once via the `Set` spread (no opt-out check) and once via a `for` loop that guarded
on `ci-recovery-opt-out`. Because the spread inserted the number first, the loop's guard
could never change the result: it was dead code.

This made the `ci-recovery-opt-out` label semantically inert for externally-blocked PRs
(they were always counted), while the code's structure implied the opposite.

Documented in issue #2284.

## Decision

Behavior **(b)**: externally-blocked PRs always count as latent CI demand, even when
`ci-recovery-opt-out` is also present. Rationale: `ci-recovery-opt-out` opts the PR out
of CI *Recovery slot consumption*, not out of runner usage entirely — the PR's own CI
still consumes a runner whenever it finally runs.

This is the behavior the existing `Set` spread already implemented. The dead loop
documented a competing intent that the code never honored.

## Fix

- `.github/scripts/sweep-budget.mjs`: removed the dead `for` loop from
  `countLatentBacklog`; moved the clarifying comment above the `Set` construction to
  make the intent explicit.
- `.github/scripts/sweep-budget.test.mjs`: added a test that pins behavior (b) —
  a PR carrying both `merge-train-blocked` and `ci-recovery-opt-out` is counted
  as latent demand (1), while a PR carrying only `ci-recovery-opt-out` is not (0).

## Verification

- `node --test .github/scripts/sweep-budget.test.mjs`: 13/13 pass (was 12/12)
- `npm run verify:fast`: all pass

## Apples

1🍎 — dead code removal + one new test case in 2 files.
