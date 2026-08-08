# Handoff: Headless sweep — review-thread shepherd fixes

**Date:** 2026-07-06  
**Session:** headless-sweep-review-shepherd  
**Persona:** Producer (PR shepherd)  
**Apples:** 🍎🍎 estimated -> 🍎🍎 actual (exact)  
**PR:** #807 (`perf(ai): speed up headless win-rate sweeps`)

## Systems touched

ai-behavior-tree, ai-pathfinding, ci-policy

## Summary

Shepherded PR #807 through its final blocker (`required_conversation_resolution`
— two unresolved `copilot-pull-request-reviewer` threads). All CI was already
green; this session addressed both threads in code and resolved them.

1. **Thread 1 — real bug (fixed).** `--workers foo` → `parseInt('foo')` = `NaN`
   → `Math.max(1, NaN)` = `NaN` → worker pool ran with `concurrency = NaN` →
   the `inFlight < concurrency` guard was always false → the sweep hung silently.
   - Extracted a side-effect-free `scripts/agent/perf/winrate-sweep-args.ts`
     (`parseSweepArgs`) that validates `--workers` / `--max-frames` as positive
     integers via `Number()` + a finite/integer/`> 0` guard, hardens `parseSeeds`
     and the enemy-damage multiplier, and throws a clear, actionable error.
   - `scripts/agent/perf/winrate-sweep.ts` now imports it and wraps the main-thread
     parse in a `try/catch` that prints the message and `process.exit(1)` instead
     of hanging.
   - Added `tests/unit/winrate-sweep-args.test.ts` (23 tests): non-numeric, ≤0,
     negative, fractional, valid, and the CPU-based default for `--workers`, plus
     `--max-frames`, the damage multiplier, and `parseSeeds`.

2. **Thread 2 — DRY refactor (extracted, byte-identical).** The 4-connected BFS
   reachability flood was duplicated between `computeReachableGoalTile` and
   `computeExploreReachabilityDepth` in `src/game/ai/bt-ai-provider.ts`.
   - Extracted the shared loop into a module-level `floodReachabilityDepth()`
     helper; both callers keep their intentionally-different setup (fresh
     `Int32Array` vs reused instance scratch, and the `startIndex` derivation) and
     call the helper.
   - The expansion order (`+x, −x, +y, −y`) and `NAVIGATION_MAX_PATH_LENGTH − 1`
     bound are load-bearing for determinism and are preserved verbatim.

## Determinism (coordination guardrail)

Both fixes are **outcome-neutral** by construction: arg-parse validation cannot
affect a run, and the BFS extraction is a mechanical, byte-identical move.
**Proven** — `npm run test:headless` stays green (43/43, 11 files) with
`collision-pair-parity` (golden + two-invocation) and both beam/melee
broadphase-pipeline-determinism runs **byte-identical**. The parallel worker-pool
outcome (same seeds×weapons → same per-cell win/loss + aggregate regardless of
worker count) is unchanged by this session. Reported outcome-neutral to the
coordinator so sibling PR #789's aggregate gate does not need re-measurement.

## Verification run

- `npm run verify:fast` — pass (typecheck + lint of 6 changed files + 99 unit
  tests, including the 23 new arg-parse tests).
- `npm run test:headless` — pass (43/43; determinism assertions byte-identical).
- `npm run check:wired-systems` — pass (47 systems wired, 0 blocking; the new
  `floodReachabilityDepth` is a plain helper, not a `*System`).
- `npm run review:ledger -- validate` — valid 3-apple ledger.

## Observe before done

- **Before (broken):** `npm run ai:winrate-sweep -- --workers foo …` spun with
  `NaN` concurrency and never scheduled a task (silent hang).
- **After (fixed):** the same invocation exits code 1 with a clear
  `--workers must be a positive integer` message; valid `--workers N` still runs.
  Determinism unchanged (headless gate byte-identical, above).

## Review harness / ledger

- Ledger: `docs/knowledge/review-ledgers/2026-07-06-headless-sweep-speedup.review-ledger.json`
  (3-apple tier: `plan_review` + `code_review` loop). A third code-review round on
  the shepherd commit was run and appended; final round clean.

## Notes / risks

- `bt-ai-provider.ts` is on the deterministic AI sim path; the byte-identical
  extraction is the only safe kind of change here. Any future edit to
  `floodReachabilityDepth()` must keep the expansion order and depth bound and be
  re-validated against `npm run test:headless`.
