# Session Handoff: Headless runner pathfinding slowdown (58s → 4s)

## Date

2026-06-25

## Persona(s) adopted

**Gameplay/Systems Engineer** — a determinism-sensitive performance defect in the
headless AI provider (`src/game/ai`) with a hard "AI decisions must not change"
constraint. Squarely in the deterministic-systems lane.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2
Verdict: 🎯 Exact — one-file, behaviour-preserving perf fix to an existing system.
Heavy at the top of the 🍎🍎 band (deep multi-iteration profiling + an algorithmic
equivalence rewrite proven on real inputs), but no new module/lab/ADR, so it stays
a Small.

Hello kitties: 2/5 = 0.40 🎀

## Symptom

`npm run ai:headless -- --seed 12345` had regressed to **~58s wall / 147 fps** for
an 8547-frame run that used to finish in **< 10s**. Outcome was still correct
(VICTORY) — only speed regressed, and the slowdown was **spike-concentrated**
(individual `ai.poll()` calls of 130–530ms) during the boss-battle / leave-floor
phase on a mostly-explored map.

## Root cause (confirmed by profiling, not guesswork)

- 100% of wall time was in `findTilePath` (rot-js `Path.AStar`): **35,917 calls /
  59,110ms**. Sim systems totalled ~1s; `ai.poll()` was ~58s. Up to **139 A\*
  searches in a single poll**.
- `BehaviorTreeAI.resolveReachableGoalTile` (in `bt-ai-provider.ts`) runs a **ring
  fallback** when a goal is not _directly_ path-reachable: for radius 1..6
  (`PATH_GOAL_SEARCH_RADIUS_TILES`) it calls `findTilePath` for **every** passable
  candidate tile (~110–169 full A\* searches).
- That fallback result was **never cached** — the existing `resolvedGoalCache` only
  stores _direct-path_ successes (its key is the raw goal tile only) — so the ring
  re-ran **every poll**. While the AI chased a moving boss/gem (goal tile changes
  each frame) or spun on an unreachable explore target, it paid the full ring every
  frame.
- rot-js A\* uses an O(n²) insertion-sort open list and **explores the whole
  reachable component on a failing/hard search**; `maxPathLength` only caps the
  output array, not search-node expansion, so it does not bound failing-search cost.

## Fix (behaviour-preserving, `src/game/ai/bt-ai-provider.ts` only)

Two composed, provably-equivalent optimisations:

1. **Cross-poll memo for `resolveReachableGoalTile`.** New `resolveGoalMemo`
   keyed on `(startX,startY,goalX,goalY,radius)`, invalidated by a `navEpoch`.
   `refreshDoorNavigation` bumps `navEpoch` only when a `(world.floor +
sorted blocked-door tiles)` signature changes — i.e. exactly when the door-aware
   passable graph could change. Within an epoch the resolve is a pure function of
   its inputs, so the memo returns identical results. This collapses the "stuck,
   same start tile" case to ~0.

2. **Replaced the ring-of-A\* with a single BFS flood** (`computeReachableGoalTile`).
   `findTilePath` is topology-4 with uniform step cost, so its returned path length
   is always the optimal distance, which equals `BFS depth + 1`. One breadth-first
   flood from the start tile over the **same door-aware `passable` predicate**
   yields every reachable tile's shortest distance; ranking ring candidates by that
   distance (with the identical `distanceScore` tie-break and iteration order)
   reproduces the **exact** previous selection. The flood is bounded by
   `NAVIGATION_MAX_PATH_LENGTH` exactly as `findTilePath`'s length cap rejected
   longer paths. This turns up to ~169 A\* searches per resolve into one O(tiles)
   pass and eliminates the moving-target spikes the memo can't catch.

### Why this is safe (determinism)

- The BFS uses the identical `passable` predicate `findTilePath` uses
  (`doorAwarePassable ?? tileMap.isPassable`); bounds are always checked before the
  predicate, so it is never queried out of range.
- A\* (admissible Manhattan heuristic, topology 4, uniform cost) returns the optimal
  path length ⇒ equals BFS depth + 1. Selection uses only `path.length` +
  `distanceScore`, both reproduced exactly.
- **Verified on real inputs:** a temporary `PF_VERIFY` harness ran the old ring and
  the new BFS side-by-side on every resolve during a full seed-12345 run →
  **473 calls, 0 mismatches**. (Harness since removed.)

## Validation

- Profiler (temp): `findTilePath` **35,917 → 877 calls**, **59,110ms → 1,774ms**;
  avg 0.1 calls/frame. Frame count unchanged at 8547.
- `npm run ai:headless -- --seed 12345`: **VICTORY, 8547 frames, level 6, 21 kills,
  6 gold — byte-identical to baseline**; internal Wall Time **58.1s → 4.3s**
  (full process 6.85s), Avg FPS 147 → 1967.
- Determinism / no-regression sweep: seeds 1, 42, 777 all VICTORY in < 10s.
- `npm run verify` — **all green** (typecheck, lint, format, dead-code, 44 unit +
  integration tests, build).
- `lab-gate-check.sh`: no files added under `src/core/systems/`, so its result is
  unchanged from main. (Known issue: pathologically slow under Git-Bash on Windows;
  runs fast in CI on Linux — confirmed in the 2026-06-26 handoff too.)

## What's Next

- Open the PR and drive to merge (`gh pr merge --auto --squash`).
- **Optional follow-up (not done, deliberately):** one ~325ms spike remains per run
  — a single explore-target re-roll that runs the `pickExploreTarget` sampler
  (`EXPLORE_REACHABLE_SAMPLE_ATTEMPTS = 40`, each a `findTilePath`). It is
  infrequent (one-off per re-roll) and optimising it would alter explore-target
  selection (RNG-coupled), so it was left alone to preserve determinism. Revisit
  only if a tighter wall-time budget is needed.

## Known limitations

- The memo assumes static tile topology per floor + door blocked-state as the only
  reachability variable. This matches (and is stricter than) the pre-existing
  `resolvedGoalCache` assumption, and `navEpoch` adds door invalidation the old
  cache lacked.

## Blockers

None. Branch verified green and ready to PR.

## Branch State

- Branch: `nalfeo-debug-headless-runner-slowness`
- All tests passing: yes (`npm run verify` fully green)
- Files changed: `src/game/ai/bt-ai-provider.ts` (only)
