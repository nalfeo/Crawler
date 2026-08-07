# Session Handoff: Stop the hourly art-ingestion chore (reconciler ping-pong)

## Date

2026-08-06

## Persona

DevOps Engineer

## Systems touched

sprite-pipeline, ci-policy

## Apples

3🍎 exact

## What Was Done

The hourly `sprite-queue-reconciler` opened an art-only promotion PR **every
cycle** (#2696…#2770, ~150 paths each) although no asset had been approved since
2026-08-01. Diagnosed live against the real refs, not the source:

- `git log --raw origin/main -- public/assets/generated/cave-floor-var-8.png`
  shows the same two blobs alternating on consecutive reconcile commits
  (`1de89798 → dfbf61ae → 1de89798 …`). `assets/queue` holds one; 44 orphaned
  `assets/checkin-*` branches (oldest 2026-07-08) hold the other.
- Cause: the two-dot `--diff-filter=AM` delta means "differs from `main` right
  now", which is equally true for new art and for a stale copy `main` already
  landed and moved past. Each cycle the source that does **not** currently match
  `main` is the one with a non-empty delta, so it is overlaid and `main` flips
  back. Every source therefore stays permanently "dirty", which also makes the
  2026-08-03 trailer/CAS retirement unreachable (it retires only sources that add
  nothing).
- Measured: **124 of 124** queue paths, and all but 29 orphan paths, were
  re-assertions of blobs `main`'s history already carried; the 29 were stale
  `src/shared/data/sprite-catalog.json` copies that would have reverted today's
  catalog to a July version.

Fix: `filterPromotablePaths` in `scripts/sprites/reconcile-queue.ts` gates each
candidate path on two blob-history facts — (1) `main`'s history has never held
the source's exact bytes at that path, and (2) `main`'s current bytes there are
ones the source's own history contains (or `main` lacks the path). Fail-closed on
any git error. Withheld paths are reported on `ReconcileResult.withheldPaths`, so
the workflow log shows a blocked approval instead of dropping it silently.
Tidy-up retirement is deliberately unchanged: applying the same filter there
would have deleted the only branch holding art that was reverted off `main`.

Observed in the real artifact (production refs, not a lab): replaying the new
filter over all 45 live sources yields **0 promotable paths** — before: ~150
"changed" paths → hourly PR; after: `noop`, no PR.

## Key Decisions Made

- Convergence is enforced on the **delta**, not on source retirement. Retirement
  cannot converge a stale source by construction, because "stale" means "always
  differs".
- Conflicts resolve in `main`'s favour. That is the only direction that cannot
  regress the shipped game, and it stops the reconciler fighting deliberate
  reverts and non-queue art flows.
- Blob-history membership rather than merge-base three-way: the queue is a
  long-lived branch whose merge base never advances while it holds stale paths,
  so merge-base reasoning would eventually block genuine re-edits.

## What's Next / Blockers

- The 44 orphan `assets/checkin-*` branches remain (they are now inert — filtered
  every cycle, no PR). A follow-up could delete branches whose every remaining
  path is superseded, but that is destructive and was kept out of this fix.
- `assets/queue` still carries 124 superseded paths, so tidy-up will not reset it.
  Harmless with the guard in place; a manual `assets/queue` reset onto `main`
  would clear it if desired.

## Retrospective

### Lessons Learned

- Diagnose ref-driven automation against the **actual remote refs**. Fetching
  `assets/*` and diffing blob ids proved the ping-pong in minutes; reading the
  reconciler source alone had already produced one fix (2026-08-03) that did not
  converge.
- `git log --format= --raw --no-renames --no-abbrev <ref> -- <paths>` gives every
  historical blob per path in one process — cheap enough to run per source per
  cycle, and far more robust than timestamp comparisons.

### Mistakes Made

- First implementation used merge-base three-way semantics. It converged today's
  state but would silently block future re-edits once the queue's merge base went
  stale. Early signal: the queue branch is long-lived and only reset by tidy-up,
  which stale paths prevent — any rule keyed on the fork point inherits that.
- Second iteration applied the staleness filter to tidy-up retirement too, which
  broke the existing revert-safety test. That test was right: the filter answers
  "should we promote", never "is it safe to delete the last copy".

### Opportunities for Future Improvement

- A deterministic guard/check that fails when a promotion diff would re-land bytes
  already present in `main`'s history at that path would catch a regression of
  this class in CI rather than in production PR spam.
- The reconciler has no alerting on repeated non-noop cycles. A simple "N
  consecutive promotion PRs with an overlapping path set" signal would have
  surfaced this within a day instead of a week.
