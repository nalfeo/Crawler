# Fix stale latent-backlog expectation greening main

**Date:** 2026-07-27
**Apples:** 1🍎 (estimated 1🍎, actual 1🍎)

## Systems touched

ci-recovery, merge-train

## Problem

`main` was red for ~3.5 hours — 5 consecutive CI failures (`492bb4be` → `08518c19` →
`2d05bd47` ×3) at a single assertion:

```
not ok 1724 - latent backlog deduplicates merge-train and recovery demand by PR number
  location: .github/scripts/sweep-budget.test.mjs:53:1
```

Commit `492bb4be8` ("unstarve the repair window") added `merge-train-blocked` to the
externally-blocked label set so externally-gated PRs stop consuming bounded
`REPAIR_WINDOW_SIZE` slots. That correctly dropped `countLatentBacklog` from 3 to 2 for
the fixture, but the transitively-dependent expectation in `sweep-budget.test.mjs` was
not updated.

## Why 2 is correct (not a weakened assertion)

`countLatentBacklog` is the union of `queueEntries` and `recoveryBacklogEntries`:

| fixture PR | labels                | queueEntries       | recoveryBacklogEntries        |
| ---------- | --------------------- | ------------------ | ----------------------------- |
| 1          | `merge-train`         | ✅ has queue label | ❌ excluded (has queue label) |
| 2          | (none)                | ❌ no queue label  | ✅ nothing excludes it        |
| 3          | `merge-train-blocked` | ❌ no queue label  | ❌ externally blocked         |
| 4          | `ci-recovery-opt-out` | ❌ no queue label  | ❌ opted out                  |

Union = `{1, 2}` → **2**. PR 3's exclusion is the intended behavior of `492bb4be8`:
`EXTERNALLY_BLOCKED_LABEL_NAMES` derives from `DISPATCH_BLOCKED_LABEL_NAMES`, and a
broad-sweep dispatch against an externally-blocked PR is a guaranteed no-op.

The production code was verified correct before the expectation was changed; this does
not relax a gate around a requirement.

## Change

- `.github/scripts/sweep-budget.test.mjs`: expectation 3 → 2, with per-PR comments
  documenting which of the two predicates includes/excludes each fixture row.
- **Added** a dedicated regression test pinning the externally-blocked exclusion on its
  own (blocked → 0, unblocked → 1), so a future change to
  `EXTERNALLY_BLOCKED_LABEL_NAMES` fails with an unambiguous message instead of
  silently shifting an aggregate count.

## Why this is a separate, minimal PR

The same correction exists inside PR #2129, but #2129 is fenced in a 17-member CI
conflict-coordination group and cannot go green while `main` is red — a deadlock
(red main → leader `BEHIND` → group cannot advance → fix stays queued → main stays red).

This PR touches only `.github/scripts/sweep-budget.test.mjs`, which lives **directly**
in `.github/scripts/` and therefore does **not** match `isCiCoordinationPath`
(`.github/workflows/**` or `.github/scripts/ci-*/**`, see
`.github/scripts/ci-conflict-coordinator/state.mjs:43`). It is exempt from coordination
and can land independently to break the deadlock.

## Observation

- Before: `node --test .github/scripts/sweep-budget.test.mjs` → 1 failing assertion.
- After: 10/10 pass.

## Follow-ups (not in this PR)

The conflict-group deadlock has a deeper root cause: branches contaminated with other
sessions' commits pull `ci-recovery/reconcile.mjs` into unrelated sprite/docs PR diffs;
union-find clustering then collapses the whole graph into one component via that hub
file; sticky membership (`shouldCoordinateComponent`) keeps PRs coordinated after
overlap is gone. Design work tracked separately.
