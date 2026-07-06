# In-game CPU hotspot analysis

> Note: I could not write to `/tmp` in this environment, so I saved this report here instead: `/home/runner/work/Crawler/Crawler/ingame-perf-analysis.md`.

## Scope

Read-only profiling of the real headless pipeline (`src/game/ai/headless-runner.ts`) with no source edits.

## Quick measurements

- Command requested: `time npx tsx src/game/ai/headless-runner-cli.ts --seed 1 --weapon sword --max-frames 600`
- Shell wall time: **2.38s**
- In-run reported wall time: **1.2s**
- In-run reported sim throughput: **~482 FPS**
- Outcome is `TIMEOUT` only because `--max-frames 600` stops after 10s of game time.

## Pipeline shape / system count

### Headless pipeline

- File: `src/game/ai/simulation-step.ts:125-257`
- Floor 1 runs **45 built-in system invocations per frame** (+ optional `preSystems` / `postSystems`).
- There is **no frame-level scheduler** here; almost everything is called every frame, with skipping handled only inside individual systems.

### Visual pipeline

- Core step: `src/engine/sim/simulation-step.ts:91-143`
- Floor wiring: `src/bootstrap/floor-main-scene-options.ts:107-159`
- Visual Floor 1 also lands at **45 built-in invocations/frame** (25 core + 14 pre + 6 post).

## 600-frame headless profile (seed 1, sword)

Average live counts during the sample:

- `Position + Size` entities seen by collision: **84.3/frame** (max **94**)
- `Enemy` entities: **19.7/frame** (max **28**)

Top measured costs:

| Rank | Call                        | Total ms / 600f | Avg ms / frame | Share |
| ---- | --------------------------- | --------------: | -------------: | ----: |
| 1    | `aiProvider.poll`           |          248.20 |          0.414 | 47.8% |
| 2    | `enemyAISystem`             |           80.86 |          0.135 | 15.6% |
| 3    | `fovSystem`                 |           39.10 |          0.065 |  7.5% |
| 4    | `collisionSystem`           |           18.72 |          0.031 |  3.6% |
| 5    | `weaponSystem`              |           14.52 |          0.024 |  2.8% |
| 6    | `floor1EnemyDirectorSystem` |            9.29 |          0.015 |  1.8% |
| 7    | `statSystem`                |            8.70 |          0.014 |  1.7% |
| 8    | `floorObjectiveSystem`      |            7.80 |          0.013 |  1.5% |

## AI behavior-tree findings

### Important correction

- File: `src/game/ai/bt-ai-provider.ts:452-679`
- `bt-ai-provider.ts` is the **single player AI provider**, not “one BT per enemy”.
- So its cost is **once per frame**, not once per enemy per frame.

### Tree tick count

- Tree shape: `src/game/ai/bt-ai-provider.ts:701-732`
- Tree runtime: `src/game/ai/behavior-tree.ts:325-333`
- Sampled over 600 frames: **15 node ticks/frame average**, **32 unique nodes** in the tree.
- In this early run, the selector usually succeeds at `Progress`, so later Track A branches are not ticked.
- There is **no memoization at the tree layer** beyond `BTSequence` / `BTSelector` `currentIndex` state (`src/game/ai/behavior-tree.ts:85-176`).

## Hotspots and opportunities

### 1) Player AI poll dominates frame time

- Files:
  - `src/game/ai/bt-ai-provider.ts:2142-2335`
  - `src/game/ai/bt-ai-provider.ts:4197-4218`
  - `src/game/ai/bt-ai-provider.ts:3089-3295`
  - `src/game/ai/bt-ai-provider.ts:4524-4647`
  - `src/game/ai/bt-ai-provider.ts:1928-1965`
- Measured cost: **47.8%** of sampled CPU.
- Main internal contributors I measured:
  - `accumulateSeenTiles` — **123.1ms** total
  - `moveToward` — **81.9ms** total
  - `tree.tick` — **57.3ms** total
  - `updateGlobalDwellWatchdog` — **48.5ms** total
  - `computeTravelSteering` — **43.1ms** total
- Why it is expensive:
  - `accumulateSeenTiles` scans the **entire floor tile grid every poll** (`for ty`, `for tx`) and calls `floorMap.isVisible` per tile.
  - `moveToward` can do path resolution, A\*, string-pulling LOS scans, and waypoint wedge recovery.
  - `computeTravelSteering` scans all perceived enemies again and evaluates tactical opportunity data every travel frame.
  - `updateGlobalDwellWatchdog` re-runs enemy sensing (`findNearestEnemy`, `sumNearbyEnemyHp`) every poll.
- Optimization suggestion:
  - Move explored-tile accumulation into `fovSystem` so the FOV callback directly marks “ever seen” tiles instead of a second full-map scan.
  - Reuse one sensed-enemy snapshot per poll across watchdogs, steering, and target selection.
  - Recompute expensive travel steering / tactical opportunity evaluation only when the primary target, local threat set, or player tile changes.
  - Cache/sparsify path smoothing; only resmooth when tile/waypoint changes, not every frame.
- Expected impact: **High**
- Behavior risk: **Mostly mechanical** if caching/throttling preserves deterministic inputs; travel-steering throttling needs validation but should not require design changes.

### 2) `accumulateSeenTiles` is a standout avoidable full-map scan

- File: `src/game/ai/bt-ai-provider.ts:4197-4218`
- Why it is expensive:
  - It loops `W * H` every frame. On Floor 1 that is roughly **33,600 tile checks/frame** before any AI decisions use the data.
  - It duplicates work already implied by `fovSystem` visibility production.
- Optimization suggestion:
  - Fuse the “visited/explored” update into `fovSystem` / `FloorMap.setVisible` and let AI read the persistent cache directly.
  - Alternatively, track only newly visible tiles from the FOV callback and OR those into `exploredSeen`.
- Expected impact: **High**
- Behavior risk: **Purely mechanical**

### 3) `moveToward` still spends meaningful CPU on path work

- Files:
  - `src/game/ai/bt-ai-provider.ts:3089-3295`
  - `src/game/ai/bt-ai-provider.ts:3297-3447`
  - `src/game/ai/bt-ai-provider.ts:3458-3477`
  - `src/core/map/pathfinding.ts:54-103`
- Why it is expensive:
  - It can call `resolveReachableGoalTile`, then `findTilePath`, then string-pull by scanning backward through waypoints with LOS tests.
  - `findTilePath` allocates a new `rot-js` A\* object per call.
  - Measured `resolveReachableGoalTile` cost was **1.10ms/call average** when it did run, even though memoization keeps call count low.
- Existing memoization already present:
  - `resolvedGoalCache`: `src/game/ai/bt-ai-provider.ts:3141-3154`
  - `resolveGoalMemo`: `src/game/ai/bt-ai-provider.ts:3297-3320`
  - BFS-based goal resolution replaced older repeated A\* fallback: `src/game/ai/bt-ai-provider.ts:3329-3446`
- Optimization suggestion:
  - Add a player-path cache keyed by `(startTile, resolvedGoal, navEpoch)` so `findTilePath` is not rebuilt when the player stays on the same tile and the goal is unchanged.
  - Only run `smoothPathIndex` when the player tile changes or the path changes.
  - If more reduction is needed, replace repeated LOS/string-pull checks with a small cached “next visible waypoint” index.
- Expected impact: **High**
- Behavior risk: **Purely mechanical** if keyed on deterministic state

### 4) `enemyAISystem` is the second-largest whole-system hotspot

- Files:
  - `src/game/enemyAISystem.ts:1626-1775`
  - `src/game/enemyAISystem.ts:886-915`
  - `src/game/enemyAISystem.ts:971-1047`
  - `src/game/enemyAISystem.ts:678-718`
- Measured cost: **15.6%** of sampled CPU.
- Why it is expensive:
  - It loops all enemies every frame and does per-enemy room checks, aggro checks, family-target overrides, and movement/path decisions.
  - It allocates `enemyList = Array.from(enemies)` and `swarmEntities = enemyList.filter(...)` each frame.
  - It also builds/uses support state such as door revision hashing and occasional stale-map cleanup.
- What is already optimized:
  - Shared ground flow field cache keyed by player tile + door revision (`886-915`), so pathfinding is **not** a naive per-enemy A\* storm.
  - Shared A\* path memo and per-enemy path refresh (`971-1047`, `678-688`).
- Optimization suggestion:
  - Remove avoidable per-frame allocations (`Array.from`, `filter`, temporary sets/lists) and reuse scratch arrays.
  - Profile whether `getDoorRevision` hashing or flow-field rebuilds spike when doors churn.
  - If needed, add coarse spatial culling so enemies far outside aggro regions take a cheaper path.
- Expected impact: **Medium**
- Behavior risk: **Purely mechanical**

### 5) `fovSystem` is a real frame cost and likely amplifies the AI cost

- Files:
  - `src/core/systems/fovSystem.ts:23-61`
  - `src/core/map/FloorMap.ts:234-249`
- Measured cost: **7.5%** of sampled CPU.
- Why it is expensive:
  - It clears the visibility buffers every frame with `fill(0)`.
  - It constructs a new `RecursiveShadowcasting` object every frame.
  - Its output then triggers the separate `accumulateSeenTiles` full-map scan inside player AI.
- Optimization suggestion:
  - Reuse the shadowcaster instance.
  - Recompute FOV only when the player moves sub-tile or when LOS-affecting geometry changes (doors).
  - If keeping per-frame FOV, at least fuse “discovered/seen” accumulation so AI does not rescan the whole map afterward.
- Expected impact: **Medium-High**
- Behavior risk: **Mostly mechanical**; event-driven FOV invalidation needs careful door/teleport handling

### 6) Collision grid is rebuilt every frame

- Files:
  - `src/core/systems/collisionSystem.ts:26-53`
  - `src/core/collision.ts:67-220`
- Measured cost: **3.6%** in the early 600-frame sample.
- Answer to the direct question:
  - **Yes** — the spatial hash is cleared and fully rebuilt every frame (`collisionSystem.ts:34-47`).
  - It indexes every entity in `query(world.ecs, [Position, Size])` (`collisionSystem.ts:31`).
  - In the sample that was **84.3 entities/frame average**, **94 max**.
- Why it is expensive:
  - Full rebuild cost is `O(n + occupied cells)` each frame.
  - `queryPairs()` can degrade toward dense-bucket `O(k²)` candidate checks with pair de-dup via a `Set`.
- Optimization suggestion:
  - Maintain an incremental spatial index for entities whose positions changed, or at minimum keep a dedicated “collidable” query instead of all `[Position, Size]` entities.
  - Consider adaptive broad-phase fallback when a bucket gets extremely dense.
- Expected impact: **Medium** now, potentially **higher late-game**
- Behavior risk: **Purely mechanical**

### 7) Existing bench data says broad-phase is good on spread scenes, bad on dense clumps

- File: `tests/bench/core-systems.bench.ts:152-178, 208-257`
- Benchmark baseline (`npm run bench`):
  - `meleeSwingSystem` grid broad-phase: **4.07x–4.68x faster** than legacy full scan in spread scenes, but **~18% slower** in dense worst-case.
  - `beamSystem` grid broad-phase: **4.11x–4.94x faster** in spread scenes, but **~48–50% slower** in dense worst-case.
- Why it matters:
  - Current real runtime likely benefits from the grid most of the time, but mob pileups can flip the win and make bucket density the hot path.
- Optimization suggestion:
  - Add an adaptive fallback: if `queryRadius` or bucket density crosses a threshold, use the old full scan for that swing/beam.
- Expected impact: **Medium**
- Behavior risk: **Purely mechanical**

## Direct answers to requested questions

### Does the collision spatial hash rebuild every frame?

Yes.

- `src/core/systems/collisionSystem.ts:34-47`
- Grid is `clear()`ed, every `Position+Size` entity is reinserted, then `queryPairs()` is computed.

### How many systems run each frame? Any conditional skipping?

- Headless Floor 1: **45 built-in invocations/frame** (`src/game/ai/simulation-step.ts:125-257`)
- Visual Floor 1: **45 built-in invocations/frame** (`src/engine/sim/simulation-step.ts:91-143`, `src/bootstrap/floor-main-scene-options.ts:107-159`)
- There is **no top-level conditional scheduler**; the pipeline always calls nearly every system and relies on inner early returns.

### How many behavior-tree nodes tick per frame? Any memoization?

- The BT is for the **player AI only**, not enemies.
- In the 600-frame sample it ticked **15 nodes/frame average**.
- Tree-layer memoization is minimal; `BehaviorTree.tick()` simply calls `root.tick()` (`src/game/ai/behavior-tree.ts:331-333`).
- Most of the actual memoization is in surrounding AI helpers (goal/path/reachability caches), not in the tree runtime.

## Highest-confidence optimization order

1. **Fuse `accumulateSeenTiles` into FOV output**
2. **Cache / throttle player pathing work in `moveToward`**
3. **Share one sensed-enemy snapshot across player-AI watchdogs + steering**
4. **Trim allocations / scratch rebuilds in `enemyAISystem`**
5. **Make FOV invalidation event-driven instead of unconditional per-frame**
6. **Investigate incremental collision indexing or adaptive dense-cluster fallback**

## Bottom line

For this 600-frame Floor 1 run, the biggest CPU savings are more likely in **player-AI perception/pathing** than in raw collision or enemy pathfinding. The single largest avoidable cost I found is the combination of:

- `fovSystem` recomputing visibility every frame, and
- `BehaviorTreeAI.accumulateSeenTiles()` rescanning the full map every frame right after that.

That pair looks like the cleanest high-impact mechanical optimization for reducing runtime CPU without changing gameplay.
