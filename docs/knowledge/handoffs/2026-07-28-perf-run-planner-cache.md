# Handoff: perf: cache estimateCurrentRunPlan on quest-state key

**Date:** 2026-07-28  
**Slug:** perf-run-planner-cache  
**Apple estimate:** 2🍎 actual  
**Session type:** Implementation (merge-intent)

## Systems touched

ai, perf-tooling

## Summary

Ran the nightly perf-optimizer pass (issue #2194). Profiled the headless Floor 1 simulation with 3 seeds × sword weapon, identified `planObjectiveRoute` as the top uncached hotspot (~10.59–10.95% total time), and landed a quest-state-keyed cache for `estimateCurrentRunPlan` that eliminates the per-frame re-computation.

Also fixed a blocking issue in the CPU profiler tool: Node 22 + tsx v4 spawns a worker thread for ESM transforms, emitting multiple `.cpuprofile` files. The profiler now selects the main-thread profile (worker ID 0) and discards worker-thread profiles instead of failing.

## Optimization

### Target identified

`planObjectiveRoute` (Held-Karp bitmask DP) at ~10.59–10.95% total profile time.  
Called per-frame via `computeTravelSteering` → `estimateCurrentRunPlan` → `estimateFloor1RunPlan` with no caching.

### Before / after

| Metric                                            | Before             | After                     |
| ------------------------------------------------- | ------------------ | ------------------------- |
| Total profile samples (3 runs, seeds 1-3 × sword) | ~27,480 samples    | 24,316 samples            |
| Estimated sim CPU reduction                       | —                  | ~11.5%                    |
| `planObjectiveRoute` in top-25                    | Yes (~10.6% total) | No (below 5% noise floor) |

Measurement command: `npm run perf:profile -- --seeds 1-3 --weapons sword --sort total`

### Cache design

A single `(runPlanCache, runPlanCacheKey)` pair in `BtAiProvider` stores the most recent computed plan.

Cache key (`buildRunPlanCacheKey` in `run-planner.ts`): all quest-state fields that affect route ordering and optional-bundle inclusion:

- All quest/objective boolean/integer state fields
- `playerGold` (raw — affects `farm-shop-gold` and `farm-merchant-weapon-gold` work costs)
- `merchantWeaponIntent?.status` and `?.cost`
- Move speed at integer ft/s precision (`Math.round(moveSpeedFtPerMs * 1000)`)
- Budget in 30-second buckets (covers optional merchant-weapon bundle affordability transitions)

**Excluded:** `nowMs`, player position (only affect time arithmetic, not route ordering).

Cache cleared on `reset()` alongside `floor1MiddleChainCache`.

### Gameplay neutrality

Fingerprint check (seeds 1-3, sword): `ae531c88204ef4985e899492bfaccf4855a823eef3a044eccfd04f281d310ed5` — byte-identical RunStats before and after the change.

The full 24-run gate sample runs on CI (not performed locally per AGENTS.md r15 for >10-run workloads).

## Files touched

- `scripts/agent/perf/profile-headless.ts` — Fixed Node 22/tsx v4 multi-profile selection (main-thread filter)
- `src/game/ai/run-planner.ts` — Added exported `buildRunPlanCacheKey(snapshot, params)` pure function
- `src/game/ai/bt-ai-provider.ts` — Added `runPlanCache`/`runPlanCacheKey` fields, caching logic in `estimateCurrentRunPlan`, cache clear in `reset()`, import of `buildRunPlanCacheKey`
- `tests/game/ai-run-planner.test.ts` — 15 new tests for `buildRunPlanCacheKey` (functional + mutation guards)

## Verification run

```
npm run verify:fast   ✅ 1839 tests passed
npm run test:mutate -- src/game/ai/run-planner.ts:416-452 --tests tests/game/ai-run-planner.test.ts
  → 16/16 mutants killed (100%)
npm run perf:fingerprint -- --seeds 1-3 --weapons sword --check /tmp/perf-narrow-before.json
  → RunStats identical (byte-for-byte match)
```

## Unresolved issues

None. The full 24-run fingerprint gate will run on CI.

## Recommended next steps

1. Watch CI for the full fingerprint gate result on this PR.
2. The next profiling pass (if needed) should look at `hasClearLineOfSight` (5.27–5.50% self) and `computeFlowField` (5.22–5.36% self) — both near the noise floor but possible future targets if they grow.
3. The profiler fix (Node 22 + tsx v4 worker-thread filter) is a tooling improvement that should be retained regardless of this optimization landing.
