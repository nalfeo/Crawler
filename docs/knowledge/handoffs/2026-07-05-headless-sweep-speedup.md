# Handoff: Headless sweep speedup (Tier A + B)

**Date:** 2026-07-05  
**Session:** headless-sweep-speedup  
**Persona:** Producer  
**Apples:** 🍎🍎🍎 estimated -> 🍎🍎🍎 actual (exact)

## Systems touched

ai-combat-balance, ai-behavior-tree, ai-pathfinding, ci-policy

## Summary

Implemented Tier A + B headless sweep performance work in one branch:

1. `scripts/agent/perf/winrate-sweep.ts`
   - Added worker-thread parallel execution for run tuples with deterministic output ordering.
   - Added `--workers` flag and default core-aware worker selection.
   - Added `--skip-events` to disable costly event capture while preserving core win/loss metrics.
   - Kept a true sequential fallback when `workers=1`.
2. `scripts/agent/perf/worker-pool.ts` (new)
   - Added reusable worker pool helper for perf scripts.
   - Fail-fast behavior with indexed result reconstruction.
3. `src/game/ai/headless-runner.ts`
   - Replaced per-frame player-entity query with `hasComponent` checks on known `playerEid`.
   - Hoisted enemy-count baseline so the pre-step enemy query is no longer repeated each frame.
4. `src/game/ai/bt-ai-provider.ts`
   - Replaced repeated per-candidate A\* reachability checks in `pickExploreTarget` fallback sampling with a single BFS reachability flood + O(1) depth lookups.
   - Moved BFS computation behind the frontier early-return so it only runs when random sampling fallback is actually needed.

## Review harness / ledger

- Ledger: `docs/knowledge/review-ledgers/2026-07-06-headless-sweep-speedup.review-ledger.json`
- Tier: 3-apple (required stages: `plan_review`, `code_review`)
- `plan_review`: completed (separate model), concerns resolved.
- `code_review`: two rounds, final round clean.
- Validation: `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-06-headless-sweep-speedup.review-ledger.json` (pass).

## Verification run

- `npm run verify:fast` (pass, after implementation + after review fixes).
- `npm run ai:winrate-sweep -- --seeds 1-2 --weapons sword --max-frames 1200 --workers 2 --skip-events` (CLI smoke pass for new flags/worker path).
- `npm run verify` reaches PR prerequisite checks and reports expected artifact gates if ledger/handoff were absent; after adding them, run `npm run verify:pr-prereqs` as final pre-PR gate.

## Notes / risks

- Tier B BFS changes preserve determinism per-run, but can shift RNG consumption sequence versus prior A\*-sampling behavior on some seeds (expected and acceptable for perf-focused AI reroll behavior).
- Worker execution preserves deterministic reporting order by indexing each task and rebuilding results by task index.
