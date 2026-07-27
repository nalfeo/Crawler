# CI Recovery: extend stale-marker typo promotion to 2 contiguous hex digits

**Date:** 2026-07-27  
**Session slug:** ci-recovery-typo-threshold  
**Apple estimate:** 1🍎  
**PR:** Closes #2115  

## Summary

Fixed a deterministic defect in the CI recovery automation that caused the PR #2010 recovery
loop to make no progress: the stale-marker typo-promotion threshold was limited to exactly
1 differing hex digit, but the Copilot agent that previously worked on PR #2010 wrote a
marker SHA differing by **2 adjacent hex digits** ("19" → "20"). This kept the review thread
unresolvable forever.

## Root Cause (PR #2010 incident)

1. Copilot agent replied to thread PRRT_kwDOSvo2Ms6Tv5hP with
   `✅ Addressed in e6380eb20825a047d75c65e62f11f3fe20afef77` — the actual HEAD commit
   was `e6380eb20825a047d75c65e62f11f3fe19afef77` (differ at positions 32-33: "19"→"20").
2. The 404-confirmed missing SHA failed the `differsByExactlyOneHexDigit` promotion guard
   (2 digit differences, not 1) → thread remained an unresolved blocker.
3. Copilot cloud-agent dispatches all failed immediately: `claude-sonnet-4.5` model unavailable.
4. New commits on `main` → PR became dirty → stale lock released via `conflict-or-train-short-circuit`.
5. Loop incident filed as issue #2115.

## Fix

`reconcile.mjs`: replaced `differsByExactlyOneHexDigit` with `isNearHexTypo` which accepts:
- Exactly 1 differing hex digit (same as before)
- Exactly 2 differing hex digits that are **contiguous (adjacent)** positions

Contiguity guard is intentional: 2 non-adjacent changed digits more likely indicate a
genuinely different commit than a single transcription slip.

## Files Touched

- `.github/scripts/ci-recovery/reconcile.mjs` — replace function, update log message, update comment
- `.github/scripts/ci-recovery/reconcile.test.mjs` — update 3 existing assertions, add 2 new tests
- `.github/scripts/sweep-budget.test.mjs` — update stale test assertions to reflect correct behavior:
  `merge-train-blocked` PRs are correctly excluded from latent backlog (they cannot be dispatched),
  and old test was vacuous for its own deduplication claim. Adopted same fix as PR #2120.

Note: `router.mjs` was initially changed to restore `merge-train-blocked` to the backlog count, but
this was incorrect — the `492bb4be8` behavior is correct and the test was stale. The router.mjs
change was reverted; only the test was updated (aligned with PR #2120 by @nalfeo).

## Verification

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` → **148/148 pass**
- `node --test .github/scripts/ci-recovery/state.test.mjs` → **43/43 pass**
- `node --test .github/scripts/ci-recovery/dispatch-table.test.mjs` → **46/46 pass**
- `node --test .github/scripts/ci-recovery/characterization.test.mjs` → **5/5 pass**
- `node --test .github/scripts/sweep-budget.test.mjs` → **11/11 pass** (pre-existing failure on main fixed)

## Systems touched

ci-recovery

## Unresolved Issues

- PR #2010 still has merge conflicts (dirty) and Prettier formatting issues in
  `src/engine/MobAbilityVfx.ts`. Those are pre-existing issues on the PR's branch
  that the CI recovery will address on its next sweep once the automation lock is re-acquired.
- The `claude-sonnet-4.5` model unavailability is an infrastructure issue outside this fix's scope.

## Recommended Next Steps

- The automation will re-attempt PR #2010 on the next sweep. With the typo-promotion fix
  in place, if the review thread marker is valid on the next attempt, it will be auto-resolved.
- If `claude-sonnet-4.5` remains unavailable, the automation may need a model fallback or
  the model name in the copilot agent dispatch configuration should be updated.
