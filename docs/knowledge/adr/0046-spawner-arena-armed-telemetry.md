# ADR 0046: Spawner-arena "ever armed" latch and `resolvedArmed` telemetry

## Status

Accepted

## Date

2026-07-05

## Estimated Complexity

🍎 x 2 — telemetry-only correctness fix spanning `src/core` (one world field)
and `src/game` (populate + measure); no gameplay/RNG change, but it re-defines
the numerator of the ADR-0045 headless gate.

## Context

ADR 0045 added the headless "AI arena lock-in" gate: it measures whether the
BT AI resolves spawner arenas that actually trapped it. The denominator is
`barrierArmed` (arenas that raised a real fence ring or locked room doors), not
the raw `triggered` count, because a triggered arena whose barrier code path was
a no-op never traps the AI.

A post-merge Copilot review of PR #764 found that `computeSpawnerArenaMetrics`
(`src/game/ai/headless-runner.ts`) computed `barrierArmed` as:

```ts
if (hasFence || hasLockedDoors || state === 2) barrierArmed += 1;
```

The `|| state === 2` term was wrong. The spawner state machine has an
**IDLE→RESOLVED short-circuit** (`spawnerArenaSystem.ts`): a spawner killed
while still IDLE — before it ever raised a barrier — banks its XP and jumps
straight to `RESOLVED` (state 2). Those never-armed arenas were counted as
`barrierArmed`, and because the fence/door snapshots are cleared on resolve,
`state === 2` was also the only signal that kept a genuinely-armed-then-resolved
arena in the count. Mixing the two inflated `barrierArmed` with never-armed
runs, diluting `resolved / barrierArmed` toward 1.0 and **masking** a real "AI
walked past an armed barrier" miss — the exact failure the gate exists to catch.

Simply restricting `barrierArmed` to real barriers is not enough on its own:
the gate's numerator was the raw `resolved` count (all terminal arenas,
including IDLE→RESOLVED short-circuits). With a real-only denominator and an
all-terminal numerator, `resolved / barrierArmed` can exceed 1.0 and mask misses
even harder.

## Decision

Track "a real barrier was raised at some point in this run" with a persistent
latch, and gate on a numerator drawn from the **same armed population** as the
denominator.

1. **`GameWorld.spawnerArenaEverArmed: Set<number>`** (`src/core/world.ts`).
   A spawner eid is added **only** when a non-empty barrier is actually stored —
   at the two Idle→Locked points in `spawnerArenaSystem.ts`: right after
   `spawnerArenaDoors.set(eid, cached)` when `cached.length > 0`, and inside the
   `snapshot.length > 0` fence branch. The set is a latch: it is **never cleared
   on resolve**, so a killed-but-genuinely-armed arena stays counted.

2. **`barrierArmed`** is now `spawnerArenaEverArmed.has(eid)` — real barriers
   only. IDLE→RESOLVED short-circuits are excluded.

3. **New metric `resolvedArmed`** (`SpawnerArenaMetrics` in `src/game/ai/types.ts`)
   counts arenas that are both ever-armed **and** `state === 2`. The ADR-0045
   headless gate (`tests/headless/spawner-arena-win-rate.test.ts`) now computes
   `resolvedArmed / barrierArmed` — both over the armed population, so the ratio
   is ≤ 1.0 and correctly exposes an AI that walked past an armed barrier.
   The raw `resolved` field is retained as "all terminal arenas" telemetry.

This is telemetry-only: `Set.add`/`.has` with no iteration feeding gameplay
output, so no RNG or gameplay path changes and the Floor-1 win-rate is
unaffected (re-verified against the real headless artifact — see handoff).

## Consequences

### Positive

- The ADR-0045 gate can no longer be silently defeated by IDLE→RESOLVED
  short-circuits; a genuine "walked past an armed barrier" miss now fails it.
- `resolvedArmed / barrierArmed` is a well-defined ratio in `[0, 1]`.
- The sealed-room door-lock lifecycle is now covered by unit tests
  (`tests/unit/spawner-arena.test.ts`), including the empty-doors no-op path
  and the short-circuit `everArmed === false` invariant.

### Negative

- One more per-world `Set` to reason about in the spawner-arena lifecycle.

### Risks

- The latch shares the per-world lifetime of `spawnerArenaDoors` /
  `spawnerArenaFence`, which are also never bulk-cleared. The sole consumer,
  `runHeadless`, uses a fresh world per run, so there is no cross-run
  contamination. If a future floor-reset path reuses a world in place, it must
  clear `spawnerArenaEverArmed` alongside the door/fence caches.

## Alternatives Considered

- **Only fix `barrierArmed`, keep `resolved` as the numerator.** Rejected: a
  real-only denominator with an all-terminal numerator pushes the ratio above
  1.0 and masks misses harder — the opposite of the fix's intent (flagged as
  blocking in plan review).
- **Derive "armed" from the live fence/door caches at measurement time.**
  Rejected: those snapshots are cleared on resolve, so a resolved arena would
  read as never-armed — which is exactly the confound that motivated the
  `|| state === 2` bug.
