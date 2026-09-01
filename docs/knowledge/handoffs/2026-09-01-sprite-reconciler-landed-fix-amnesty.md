# Handoff: sprite-queue-reconciler landed-fix amnesty (duplicate PR #4043)

## Systems touched

sprite-pipeline, ci-automation

## Apple estimate

🍎🍎 (2) — tooling-only (`scripts/sprites/reconcile-queue.ts` + its test +
workflow comment + ADR amendment), no runtime gameplay change. Capped per the
tooling-only apple cap.

## What happened

The user flagged PR #4043 ("chore(assets): reconcile queued sprite edits (2
art paths)") as a duplicate of already-merged PR #4031 — same title, same
asset. #4043 was closed in a prior session and `assets/queue` was manually
converged with `main` (commit `f97bbd428`) to unblock the immediate symptom.
This session root-caused and fixed the underlying defect so the reconciler
converges on its own next time, instead of needing another manual rescue.

## Root cause

Traced via real git blob SHAs (not guesswork): `main`'s **full history** for
`public/assets/generated/.../player-walk-cycle-male.png` shows only the
original good commit — the bad blob harvested onto `assets/queue` was
**never** committed to `main`. That's because, before PR #4031 merged, a
follow-up commit restored the good bytes **directly on the `assets/promote`
branch** (not on `assets/queue`), so the squash-merge landed clean bytes and
`main`'s history was never polluted.

That broke the reconciler's two convergence guards in opposite directions:

- `filterPromotablePaths` (promotion-side) blocks re-promoting a path only if
  `main`'s **history** ever held the source's exact stale blob. Since it
  never did, the stale path stayed "promotable" and reopened a duplicate
  promotion (#4043) on the very next cycle.
- `sourceAddsNothingToBase` (retirement-side) only retires a source when its
  **current** bytes equal `main`'s **current** bytes. `assets/queue`'s bytes
  still held the old edit, so retirement correctly refused — leaving queue
  permanently "dirty" with no path to convergence.

Full details and the amendment write-up: `docs/knowledge/adr/2026-07-24-sprite-queue-reconciler.md`
(Amendment 2026-09-01).

## Fix

Added **landed-fix amnesty** to `sourceAddsNothingToBase` in
`scripts/sprites/reconcile-queue.ts`: an optional `landedRef` parameter (wired
to `LANDED_SCRATCH_REF`, the just-landed promotion's own un-squashed final
tree, already fetched by `findLandedPromotion`). When a source's bytes at a
path diverge from `main`'s current bytes, the divergence is dropped from the
retirement-blocking set if the landed promotion's own tree at that path
already matches `main`'s current bytes exactly — i.e. the fix was already
applied and verified inside the very promotion authorizing this retirement.
Fails closed (no amnesty) if `main` lacks the path or any blob lookup fails.

`filterPromotablePaths` was deliberately left unchanged: once retirement
resets queue to `main`, the staleness question for that path is moot going
forward. Verified with a new regression test reproducing the exact #4031/
#4043 scenario end-to-end (bad bytes only reach queue → promote-branch fix
lands clean → next cycle retires queue → a further cycle is a no-op with the
PR queue empty).

## Process rule (documentation half)

Added a process-rule paragraph to `.github/workflows/sprite-queue-reconciler.yml`'s
header comment: any art fix applied directly to `main`/`assets/promote`
**after** a promotion has already merged (outside the fix-then-merge window
the amnesty covers) must still be mirrored onto `assets/queue` by hand, or the
same stuck state recurs.

## Verification

- New test: `LANDED-FIX AMNESTY: converges instead of re-opening a duplicate PR
forever (regression: PR #4043 duplicating merged PR #4031)` in
  `tests/unit/sprites/reconcile-queue.test.ts`, in the
  `findLandedPromotion / tidyUpLandedPromotion (real git)` describe block —
  passes.
- Full suite: `npx vitest run tests/unit/sprites/reconcile-queue.test.ts` — 90/90
  passed (no regressions, including the REVERT SAFETY tests).
- `npx eslint scripts/sprites/reconcile-queue.ts tests/unit/sprites/reconcile-queue.test.ts` — clean.
- `npm run typecheck` — clean.

## Files changed

- `scripts/sprites/reconcile-queue.ts` — `sourceAddsNothingToBase` +
  `retirable` (landed-fix amnesty logic + JSDoc).
- `tests/unit/sprites/reconcile-queue.test.ts` — new regression test.
- `.github/workflows/sprite-queue-reconciler.yml` — process-rule comment.
- `docs/knowledge/adr/2026-07-24-sprite-queue-reconciler.md` — Amendment
  2026-09-01.

## Review

Apple count is 2, so per `docs/agent-os/policies/review-harness-policy.md`
this only needs tests/CI, no independent post-diff review required.
