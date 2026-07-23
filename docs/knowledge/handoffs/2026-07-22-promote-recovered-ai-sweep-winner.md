# Promote recovered AI Sweep winner to runtime default

**Date:** 2026-07-22
**Persona:** Game Designer

## Systems touched

ai-pathfinding, ai-combat-balance

## Apples

Estimated 🍎🍎 · Actual 🍎🍎 · exact

## Summary

- Promoted the recovered AI Sweep winner config as the runtime `DEFAULT_CONFIG`
  in `src/game/ai/bt-ai-tuning.ts`. Only 3 of 11 fields differed from the prior
  default:
  - `pathingMode`: `LEGACY` → `RISK_REWARD_FUSED`
  - `retreatThreshold`: `0.15` → `0.1`
  - `farmPullWeight`: `0.07` → `0.12`
- Source evidence: corrected recovery GitHub Actions run `29893475612`
  (completed success), workflowSha `18929bed51edb1979db2650e3329cf4fe63ff418`.
  All 8 validation combos + aggregate passed. Composite and lexicographic
  winners agreed on this exact config. Validation: 294/300 wins (98%; 98/100
  each for sword/bow/baseball-bat) vs incumbent legacy+legacy
  (`retreatThreshold=0.15`) at 286/300 — +8 wins, +2.6667pp, with 3 incumbent
  win→loss flips allowed under the merged net-win rule.
- Synced the previously-duplicated CLI default in
  `src/game/ai/headless-runner-cli-lib.ts` (`defaultCLIArgs()`) to import and
  read `DEFAULT_CONFIG.pathingMode` / `DEFAULT_CONFIG.decisionMode` instead of
  hardcoded `LEGACY` literals, closing a drift vector between the CLI and the
  production default.
- Fixed stale doc comments that claimed `LEGACY` was the default / that
  `RISK_REWARD_FUSED` was unimplemented, in `src/game/ai/types.ts` and
  `src/game/ai/bt-ai-provider.ts`, plus stale `// SSOT` inline comments in
  `scripts/agent/perf/gen-configs.ts`.
- Added `tests/unit/ai/default-config-promotion.test.ts` — the task's explicit
  hard gate — asserting all 11 `DEFAULT_CONFIG` fields resolve exactly to the
  winning sweep config, to prevent silent drift going forward.

## Test triage (constraint: never weaken the winning config to pass a test)

Full `npm run test:unit` initially broke 3 of ~4957 tests after the edit — a
small, well-contained blast radius:

- `tests/unit/ai/slack-aware-decision-mode.test.ts` — "defaults to LEGACY on
  both axes" was a direct assertion about default-value behavior. Since the
  default legitimately changed, the test was **updated** (not weakened) to
  assert the new production default, with a companion test added to confirm
  explicit `LEGACY` opt-in still works.
- `tests/game/behavior-tree-ai.test.ts` — two tests ("latches a retreating
  threat...", "sidesteps collision-course projectiles...") test mechanics
  orthogonal to the pathing-mode A/B axis. Pinned `pathingMode:
AIPathingMode.LEGACY` explicitly in each so they stay stable across future
  default-pathing promotions.
- The retreat-latch test also depended on the exact `retreatThreshold` value
  (its fixture set player health to 10%, "below the 15% retreat threshold" —
  the retreat trigger in `bt-ai-provider.ts` uses a strict `<` comparison, so
  10% no longer clears the new `0.1` threshold). Fixed by dropping the
  fixture's health to 5%, unambiguously below the threshold regardless of
  where that knob is tuned, rather than pinning `retreatThreshold` in the
  test (which would have made the test fragile to intentional future
  threshold retuning of an already-pinned-LEGACY scenario).

No production config value was altered to satisfy a test.

## Evidence

- `npm run test:unit`: 4951 passed, 7 skipped, 0 failed (388 files).
- `npm run verify:fast`: passed (typecheck, lint, changed-scope tests, physics/
  size/weight coverage all OK).
- `npm run verify` with `VERIFY_FULL=1` (headless Floor 1 gate) run locally:
  full test suite (1408 passed / 1 skipped) plus headless completion gate —
  see verification run in session logs.
- `npm run scope`: `gameplay_safe=false` (expected — this changes the AI
  runtime default), confirming the headless gate needed to run.
- Sweep evidence itself (run `29893475612`) was NOT re-run; per task
  instructions this recovery run is accepted evidence and broad sweeps
  (>10 runs) default to GitHub infrastructure, not local re-dispatch.

## Notes

- Environment note (not code-related): this shared multi-worktree environment
  intermittently corrupts/empties `node_modules` outside of any action taken
  in this session; recovered twice via robocopy-mirroring from a sibling
  worktree's completed install, verifying directory count and
  `typescript/bin/tsc` presence before AND after each copy. `npm ci`/`npm
install` remain unusable due to an org registry proxy gap on
  `fast-uri@3.1.4`. No action needed from reviewers; flagged here only so a
  future session doesn't waste time re-diagnosing the same root cause.
- `bash` on `PATH` in this environment resolves to the WSL interop shim,
  which does not forward arbitrary env vars into the WSL session unless
  listed in `WSLENV`. Running `VERIFY_FULL=1 npm run verify` locally required
  also setting `$env:WSLENV="VERIFY_FULL/u"` for the flag to reach
  `scripts/agent/verify.sh`.
