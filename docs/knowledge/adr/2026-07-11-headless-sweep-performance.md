# ADR: Cache deterministic visibility and shard broad sweeps

**Status:** Accepted  
**Date:** 2026-07-11

## Context

The canonical Floor 1 weapon sweep runs 100 seeds for each of three weapons. GitHub
Actions previously created one job per weapon and ran all 100 seeds sequentially.
CPU profiling of an individual run also found two redundant per-frame costs:

- recursive-shadowcasting FOV was recomputed while the player remained in the same
  sub-tile and map transparency was unchanged;
- `BehaviorTreeAI` scanned the entire map every poll to copy visible tiles into a
  second cumulative bitmap, although `FloorMap` already owns persistent tile-level
  discovery state.

The optimization must preserve deterministic outcomes, RNG consumption, system order,
and the three existing per-weapon artifact contracts.

## Decision

1. `TileMap` exposes a monotonic transparency revision. Runtime mutation methods
   increment it only when the transparent bit actually changes, so idempotent door
   writes do not invalidate caches.
2. `fovSystem` caches by `FloorMap` identity, player sub-tile, sub-factor, and
   transparency revision. An identical key reuses the existing visibility bitmap.
3. `BehaviorTreeAI` reads `FloorMap`'s tile-level discovered state directly instead
   of rebuilding a duplicate full-map bitmap every frame. Perception remains
   permissive until a real visibility pass has populated the map.
4. The broad weapon-sweep workflow distributes each weapon's seeds across four
   deterministic matrix shards. Fan-in jobs reject malformed, missing, duplicate,
   unexpected, or out-of-order records, then recreate the original
   `weapon-sweep-{weapon}` JSON artifacts in canonical seed order.

## Consequences

### Positive

- Median individual run time on the three-seed benchmark falls from 14,359 ms to
  10,312 ms (28.2%).
- Four balanced shards reduce the simulation portion of each weapon sweep by a
  theoretical 75% before the individual-run improvement, while retaining the
  existing final artifact names and schema.
- Visibility behavior remains identical because the skipped FOV computation is a
  pure function of the complete cache key.
- Aggregation fails closed rather than allowing record counts to hide duplicate or
  missing seeds.

### Negative and risks

- Runtime code that mutates `TileMap.flags` directly would bypass the transparency
  revision. Runtime systems use the mutation methods; direct writes remain confined
  to map construction and labs before their first FOV pass.
- The workflow creates more short-lived GitHub jobs and intermediate artifacts.
- End-to-end wall time depends on available GitHub runner concurrency and must be
  measured on the canonical workflow.

## Alternatives considered

1. **Worker threads inside each weapon job.** Rejected as the sole sweep strategy:
   standard hosted runners provide limited cores, and worker startup/contention
   makes a guaranteed 50% reduction unlikely. The existing worker-pool remains
   suitable for other sweep tools.
2. **Cache raw subtile discovery in the AI.** Rejected because AI frontier and
   perception semantics are tile-level; `FloorMap` already provides the correct
   authoritative cache.
3. **Optimize LOS or flow-field computation first.** Deferred because profiling
   identified redundant FOV and discovery work, and those changes met the individual
   25% target without higher-risk pathfinding memoization.
4. **Add a performance dependency.** Rejected: existing ROT.js, typed arrays, and
   GitHub matrix primitives cover the need without another runtime or maintenance
   surface.
