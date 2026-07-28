# Fix stale latent-backlog test broken by the emergency router fix

**Date:** 2026-07-27
**Apples:** 1🍎 (declared 1🍎, actual 1🍎)

## Systems touched

ci-policy

## Summary

`main` was red. `node --test .github/scripts/sweep-budget.test.mjs` failed on a
clean `origin/main` (`2d05bd470`) with **8 passed / 1 failed** in that file, and
that single failure blocked `Lightweight Checks` → `Merge gate` → `ci` on
**every open PR**, including PR #2118. It was unrelated to any PR's own diff.

Failing assertion: `latent backlog deduplicates merge-train and recovery demand
by PR number` expected `countLatentBacklog(...) === 3`, got `2`.

## Root cause

Commit `492bb4be8` (2026-07-27 09:25, **emergency direct-to-main**,
"unstarve the repair window so the merge train can refill") fixed a real
production deadlock: externally blocked PRs were consuming slots in the bounded
`REPAIR_WINDOW_SIZE=6` sweep, so every dispatch was a guaranteed no-op. Its
defect-2 fix added `isExternallyBlocked()` to `eligibleTrainRecoveryPulls()`.

`merge-train-blocked` is in `DISPATCH_BLOCKED_LABEL_NAMES`, so that PR class
stopped appearing in `recoveryBacklogEntries()` — and therefore stopped
contributing to `countLatentBacklog()`. Expected demand dropped 3 → 2.

Because it landed direct-to-main, this test was never run against the change.

**The behaviour is correct; the test was stale.** `countLatentBacklog` feeds
`computeSweepBudget` (`20 - nonSweepJobs - latentBacklog`) — it reserves runner
capacity for imminent demand. A `merge-train-blocked` PR is skipped
unconditionally by reconcile, so it will not be dispatched and consumes no
runners. Counting it needlessly throttled broad sweeps. Verified empirically per
label class:

| labels                | `queueEntries` | `recoveryBacklogEntries` |
| --------------------- | -------------- | ------------------------ |
| `merge-train`         | ✅             | —                        |
| _(none)_              | —              | ✅                       |
| `merge-train-blocked` | —              | — ← changed              |
| `ci-recovery-opt-out` | —              | —                        |

## The more interesting finding: the test was vacuous for its own name

`eligibleTrainRecoveryPulls()` excludes the `merge-train` label
**unconditionally** (outside the `!directlyTriggered` guard), and
`queueEntries()` **requires** that label. The two selectors are therefore
**provably disjoint** — no label fixture can put one PR in both.

So the `new Set([...])` in `countLatentBacklog` could never fire for this
fixture, and a test named _"deduplicates … by PR number"_ **never once
exercised deduplication**. Its four PRs have four distinct numbers. It only ever
asserted a filtering total, which is exactly why a filtering change silently
broke it.

This is the same defect shape logged three times already this session: a pin
that cannot fail for the reason it claims.

## Fix

Split the one weak assertion into three that pin behaviour rather than a total:

1. **Per-label-class contribution** — each class asserted individually, so a
   future change names _which_ PR moved instead of just shifting a number. A
   bare union total lets one PR drop in and another drop out unnoticed.
2. **Union** — still asserts the aggregate (now 2), with the `492bb4be8`
   citation inline so the next reader does not "restore" the 3.
3. **A real dedup test** — passes the same PR twice, the only reachable way to
   exercise the `Set` given the disjointness above.

Also pinned `now` to a fixed date; the fixture's `created_at` is hardcoded while
`countLatentBacklog` defaulted `now = new Date()`, so any future time-dependent
staleness logic would have rotted this test again.

## Verification

11/11 pass. Both new behaviours **mutation-proven to fail**:

| mutation                                 | result                                           |
| ---------------------------------------- | ------------------------------------------------ |
| drop `externallyBlocked` from exclusions | ✖ both behaviour tests fail; dedup test passes ✔ |
| replace the `Set` with a plain array     | ✖ only the dedup test fails                      |

The clean separation is the point: each test fails for its own reason and no
other. `npm run verify:fast` green.

## Follow-up for whoever owns CI policy

An emergency direct-to-main path that skips the guard suite will keep doing
this. The change itself was right and urgent; the gap is that nothing re-ran
`.github/scripts/**` tests afterwards. Worth a post-merge check on
direct-to-main pushes.

## Amendment (2026-07-27, after rebase onto main)

PRs #2131, #2136 and #2141 each re-aligned this test's expected counts after this
branch was cut, so the count fix carried here is redundant and was dropped in favour
of main's version. What survives is the part none of those five PRs addressed: the
test named for deduplication could not observe deduplication.

`eligibleTrainRecoveryPulls` excludes every queue-labelled PR (`hasQueueLabel ||`,
`.github/scripts/ci-recovery/router.mjs:476`) and `queueEntries` selects exactly the
queue-labelled PRs, so the two demand sources are **disjoint by construction**. With
singly-classified fixtures the `Set` in `countLatentBacklog` can never collapse
anything: replacing it with a plain array leaves the suite green.

Split into three tests that each pin a distinct property — union accounting (renamed,
no longer claiming to test dedup), dedup against a duplicated listing entry, and the
disjointness invariant itself so that dropping `hasQueueLabel` from the recovery
exclusions fails loudly instead of silently double-counting.

Mutation-proved: swapping `new Set([...])`/`.size` for an array/`.length` (1 site,
confirmed by `git diff --stat`) turns **exactly** the dedup test red and nothing else.
