# AI Pathfinding

How the AI runner and enemy systems find tiles, and the performance traps
they have hit in the past. Pair with `docs/systems/04-enemy-ai.md`.

## rot-js A\* `maxPathLength` does not cap search cost

rot-js `Path.AStar`'s `maxPathLength` option caps the length of the returned
path — it does **not** cap the number of nodes the search expands. When a
target is unreachable or requires a long detour, A\* still explores the whole
reachable component, and the internal open-list is an unsorted array with
`O(n²)` insertion-sort cost. On a real Floor 1 map (~10 000 walkable tiles)
this is `~10⁸` operations per failed search.

Symptom seen in the field: `HeadlessRunner.step()` at ~4.5 s per game tick,
turning a `30 s` headless-gate budget into a `58 s` regression.

## The `resolveReachableGoalTile` ring-search anti-pattern

`resolveReachableGoalTile` falls back through radii `1..6` around a blocked
goal and runs a fresh A\* for **every** candidate tile. That is up to
~169 A\* searches per call, none of which share state. There is no cache
across calls or across candidate tiles, so a single quest that keeps polling
"nearest reachable tile" collapses the frame budget.

Replacement pattern:

- Do **one BFS flood-fill** from the actor over walkable tiles, cut off at
  radius `6`. BFS is `O(walkable)` regardless of goal count.
- Memoize on `(startX, startY, goalX, goalY, radius)`. Invalidate the memo
  when door topology changes (door opens/closes/spawns) — the walkable graph
  is otherwise stable within a room lifecycle.
- Return the first BFS-reached candidate.

BFS gives the same result as the ring search (nearest reachable tile within
radius), at a small constant multiple of a single A\* search rather than
`~169×` an A\* search.

## Wall-time budget for the headless gate

`HEADLESS_WALL_TIME_BUDGET_MS = 30_000` is calibrated to ~4.5× the slowest
dev-box combo. CI runs 2–3× slower than a dev box, so 30 s catches the
`58 s` regression class without flaking on healthy code. **Do not raise the
budget to hide slowdowns.** If a run breaches the budget:

- If frame counts are stable across re-runs and only wall-time varies →
  environmental CPU contention. Retry on a less-contended host.
- If frame counts are also unstable, or wall-time is deterministically over
  the budget → real regression. Fix it, do not raise the budget.

See `docs/agent-os/policies/ci-policy.md#incremental-change-discipline` for
the related discipline around diagnosing headless-gate flakes.

---

<!-- Source handoff: 2026-06-25-headless-runner-pathfinding-slowdown.md -->
