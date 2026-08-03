# Sprite reconciler: retire harvested sources after a promotion merges

**Date:** 2026-08-03
**Persona:** DevOps Engineer
**Apples:** 3🍎 estimated / 3🍎 actual (asset-pipeline tooling cap, `docs/agent-os/policies/complexity-policy.md`)

## Systems touched

sprite-pipeline, sprite-workflow

## The ask

> "How do we still have assets that aren't checked in. Why do we still keep
> generating art check in PRs" → "Make the real fixes in pipeline then close the
> PRs and let it start over."

## Root cause (proven, not inferred)

`scripts/sprites/reconcile-queue.ts` computes each source's contribution as:

```
git diff --no-renames --name-only --diff-filter=AM <main> <source> -- <art allowlist>
```

That is a **"differs from `main`"** test, not a **"newer than `main`"** test, and
**nothing ever retires a source**. When two sources disagree about a path,
whichever source currently *agrees* with `main` drops out of its own `AM` set, so
the other source always wins the overlay — and `main` flips between them every
hour, forever.

Live evidence gathered before the fix:

| Signal                                                            | Value                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------- |
| Reconciler runs, all reporting `success`                          | 104 — the workflow was running perfectly, doing the wrong thing |
| Consecutive promote PRs #2704 / #2706 (1 h apart)                 | **identical 100-file set**, all `modified`, with exactly **inverse** patches |
| Orphaned `assets/checkin-*` branches re-harvested every cycle     | **44**, oldest `assets/checkin-20260708-024741-b7c872` |
| Current art-surface delta                                         | 155 paths (137 `public/assets/generated/`, 18 `briefs/`) |

Traced to a single path, `public/assets/generated/entries/gnome-boss-var-7.json`:

| ref                                     | blob md5 (first 10) |
| --------------------------------------- | ------------------- |
| `origin/main`                           | `3b8bf0b1c8`        |
| `29708bc` (the promote commit)          | `3b8bf0b1c8`        |
| `origin/assets/queue`                   | `8e46438bf5`        |
| `assets/checkin-20260731-204023-b1e0cb` | `3b8bf0b1c8`        |
| `assets/checkin-20260801-181522-7be968` | `8e46438bf5`        |

So "assets that aren't checked in" and "art check-in PRs keep regenerating" are
the **same** bug: the reconciler never converges, so a promotion PR opens every
hour and each one re-asserts the loser of the previous hour.

## Two designs that were disproved before this one

Recorded in full in the review ledger; summarized because they are the
non-obvious part.

1. **Watermark = the `assets/promote` tree.** Impossible: GitHub auto-deletes
   `assets/promote` on merge, so the ref does not exist (`git ls-remote` → empty).
2. **Watermark = `refs/pull/<N>/head` of the newest merged promote PR, compared
   by blob.** Measured on the live repo: of 155 candidate paths, **155** differed
   from `refs/pull/2706/head` and **148** differed even from the true promote
   commit `29708bc`. A merged promote head is a **composite** (queue + 44 orphan
   overlays + CI-recovery repair commits) and preserves no single source's bytes.
   Blob equality also cannot distinguish "already promoted" from "deliberately
   re-asserted" (ABA).

Conclusion: **only the source OID is a sound acknowledgement.**

## The fix

1. **Record what was harvested.** The promotion commit now carries
   `Queue-Source: <sha>` and `Orphan-Source: <branch> <sha>` trailers naming the
   exact tips it consumed. Deterministically ordered, so an identical harvest
   produces a byte-identical message.
2. **Retire it once — and only once — it has landed.** `tidyUpLandedPromotion`
   runs first inside the cross-process lock: it finds the most recently **merged**
   promote PR (`gh pr list --state merged`, ordered by `mergedAt`, fork-rejected
   via `isCrossRepository`, head OID verified against `refs/pull/<n>/head`), reads
   its trailers, then **compare-and-swaps**:
   - `assets/queue` is reset onto `main` only while its tip still equals the
     recorded snapshot;
   - each recorded orphan branch is deleted only while its tip still equals the
     recorded snapshot,

   both via `--force-with-lease=refs/heads/<b>:<sha>`. An approve or check-in
   that landed **after** the harvest moves the tip, the lease misses, and the
   source is left completely alone.

Four further guards came out of code review (two rounds), all covered by
regression tests that were **mutation-checked** (each test fails when its guard
is removed):

3. **Revert safety.** "The promotion merged" is *not* proof the art is still on
   `main` — a later revert puts the bytes back only on the source branches, and
   retiring them then would destroy the last copy. Before either destructive
   step, the source's art-surface delta is **re-derived against the current
   `main`**; a source that still adds anything is left alone.
4. **Trailer provenance.** The trailer scan is bounded to the PR-exclusive
   ancestry (`git log <head> --not <base>`), and the ancestry must contain
   **exactly one** commit carrying the generated promotion subject. Without this,
   a CI-recovery repair commit above the promotion could name any branch and have
   it deleted, and a >20-commit recovery stack would push the scan into inherited
   `main` history where any commit message could be read as a delete instruction.
   A subject match alone is *not* provenance — a repair commit can reuse the
   subject — so ambiguity fails closed.
5. **One base snapshot.** Every proof is derived against, and every push gated
   on, the single base tip captured at the start of the tidy-up. The base is
   re-asserted immediately before each destructive push and any movement aborts
   the remaining sweep, so a proof can never be paired with a base other than the
   one it was computed from.

Every gh/git/JSON/fetch/parse failure returns `null` / no-op — the destructive
path is fail-closed throughout, and the whole tidy-up is non-fatal so it can
never block a promotion.

`ReconcileResult` gained `tidiedQueue` / `tidiedBranches`; the workflow already
logs that JSON, so convergence is now observable per run.

## Observe before done

Rule #9 evidence is a **deterministic regression test**, not a manual run — this
is a headless script with no visual surface.

`tests/unit/sprites/reconcile-queue.test.ts` →
`CONVERGES: the very next cycle after a merged promotion is a no-op` drives the
**real** `runReconcile` against a real temp git origin:

- **Before:** cycle 1 opens a promotion PR (`status: 'pr-open'`); the orphan
  branch and queue both survive, so cycle 2 opened *another* PR with the same
  files — forever.
- **After:** cycle 1 opens the PR *and records the source trailers*; once it
  merges, cycle 2 returns `status: 'noop'` with `tidiedQueue: true` and
  `tidiedBranches: ['assets/checkin-converge-1']`, and **zero** open PRs remain.

Plus: real-git proof that the leased **delete** actually deletes; a CAS-miss test
proving art that landed after the harvest is never discarded; a **revert** test;
a **forged-trailer** test (the forgery uses the *exact* promotion subject, so it
proves the uniqueness rule and not just a string compare); a **base-race** test
that reverts `main` mid-cycle; fork-PR rejection; head-OID mismatch rejection;
gh-failure fail-closed. The real-git harness squash-merges (matching repo merge
policy) rather than fast-forwarding, so the ancestry bound is genuinely
exercised. 80 tests in the file, all of `tests/unit/sprites/` green.

## Bootstrap: how the live repo self-heals

No manual branch surgery is needed and no force-push from a human is required.

- **Cycle 1** (first run with this code): promotes as it does today — one more
  oscillation PR — **but records the source SHAs**.
- **Cycle 2** (after that PR merges): the recorded queue SHA still matches, so
  the queue is reset onto `main` and the 44 recorded orphan branches are deleted.
- **Cycle 3 onward:** `noop`.

That is what "let it start over" looks like without deleting anything by hand.

## Accepted trade-off

Resetting `assets/queue` onto `main` discards queue's version of any path an
orphan branch overwrote during that promotion (last-writer-wins overlay, the
pre-existing documented behavior). This is safe because the promotion **merged**,
so `main` provably holds the winning bytes.

## What was deliberately NOT done

The ask included "close the PRs". The plan reviewer showed this would not have
the intended effect and carried a rule #11 risk:

- #2498 head = `assets/batch-20260731-211311`, #2599 head =
  `assets/batch-20260801-070248`, #2649 head = `copilot/assetscheckin-...`.
  **None are `assets/checkin-*`**, so `scanOrphanedCheckinBranches` never
  enumerates them — closing them does not make their art harvestable.
- Issue #2495 plays no role in orphan detection.
- Closing them merely to bypass their unresolved validation would be weakening a
  gate rather than fixing it.

They should be triaged on their own merits, separately.

## Follow-ups

- `LANDED_TRAILER_SCAN_DEPTH = 20` bounds how many repair commits CI recovery may
  stack on a promote PR before the trailers fall out of scan range. Failure mode
  is benign (tidy-up skips, next merged promotion re-records), but if CI recovery
  ever pushes more than ~20 commits onto one promotion this should be raised.
- `git push` can only lease the ref it writes, so the base cannot join the same
  atomic update. The pre-push re-assertion narrows the window to the push itself;
  a revert landing inside it could still let one deletion through. That is
  recoverable by construction — the merged promotion durably records every
  retired branch's exact OID in its `Orphan-Source:` trailers, so
  `git push origin <sha>:refs/heads/<branch>` restores it.
- The trailer-ancestry bound assumes **squash** merges (the documented repo merge
  policy). If art promotions ever switch to a true merge commit, the promotion's
  commits become ancestors of `main`, the scan finds nothing, and tidy-up
  silently stops converging — fail-closed, but it would need revisiting.
- Once the live repo has converged, consider whether the `briefs/` entry in
  `ART_SURFACE_ALLOWLIST` still needs to be promotable, or whether briefs should
  only ever travel with their own PR.
