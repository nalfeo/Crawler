# ADR 0022: Extract pure BT exploration decision kernels (C1–C4) for lab + unit coverage

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 x 3 — one new pure module (`src/game/ai/exploration.ts`), behavior-preserving
delegation from the ~150 KB `BehaviorTreeAI` class, a pure-fn unit suite, one
measurable headless behaviour gate, and a new lab. Single layer (`src/game/ai`

- `src/labs`), no new ECS system, but it touches the AI decision path and the
  gate/lab infra, so an ADR records the testability seam.

## Context

ITEM #3's explicit deliverable was "improve BT exploration via four directives
(C1 prefer unexplored tiles, C2 navigate to minimap/POI targets, C3 locked-door
memory, C4 reduce stuck/wiggle) — **add labs for the exploration behavior and
unit-test the pure decision functions.**"

The directives already existed and worked — but entirely as **private methods
buried inside the ~150 KB `BehaviorTreeAI` class**. Only `computeFloorProgressScore`
was exported as a pure function; there was no exploration-specific lab, and the
existing `behavior-tree-ai.test.ts` exercised the directives only indirectly by
driving the whole class. So the spec-required deliverable — _pure-fn unit tests_
and _a lab_ over C1–C4 — was genuinely missing even though the behaviour was
present. PR #316 (ADR 0021) had pivoted ITEM #3 toward the structural
reachability bug that was the real blocker; this ADR closes the originally-scoped
testability gap without re-litigating behaviour.

Constraint: the directives are live in the headless completion gate (9 weapon ×
seed combos). Any refactor **must not change behaviour**.

## Decision

### 1. Extract the decision kernels into a pure module, and delegate

Add `src/game/ai/exploration.ts` containing the four directives as pure,
deterministic functions (no `Math.random`, no `Date.now`, no hidden world
state), and have `BehaviorTreeAI` **delegate** to them rather than keeping
private copies. Delegation (not a parallel re-implementation) means the unit
tests and lab cover the _real production path_.

- **C1 — `findNearestFrontierTile(grid, startX, startY, minDistancePx, maxTiles,
visited)`** + the `FrontierGrid` read-only grid view. A breadth-first search
  through seen, passable ground for the nearest fog-bordering tile past a minimum
  travel distance. The class builds a tiny `FrontierGrid` adapter over its
  `tileMap` / fog / door-aware passability and converts the returned tile back to
  pixels.
- **C2 — `pickNearestPoi(candidates, fromX, fromY, maxRadiusPx)`.** Nearest
  still-relevant POI strictly inside the scan radius; `findNearestRelevantNpc`
  now collects `(NpcTarget & PoiCandidate)[]` (keeping its discovery
  side-effects) and delegates the selection. This is the C2 the review flagged
  as unverified: the BT **does** steer toward discovered-but-unvisited NPC/objective
  markers, not only frontier tiles — now provable in isolation.
- **C3 — `updateLockedDoorMemory(known, blocked)` / `isDoorKnownLocked`.**
  `refreshDoorNavigation` records currently-blocked doors and forgets any whose
  unlock condition is now satisfied.
- **C4 — `nextStuckFrames(prev, movedPx, epsilon)`** and the **`DwellTracker`**
  net-displacement watchdog. The poll's per-frame stuck counter and the explore
  dwell watchdog both delegate; `DwellTracker.update` reproduces the exact
  arm → progress → accumulate → fire (auto-reset) state machine.

Behaviour preservation is verified, not assumed: the full unit suite
(174 files / 1859 tests) and the headless completion gate (**36/36**,
`[6, 2, 5] × {sword, bow, baseball-bat}`) pass unchanged after the delegation.

### 2. Pure-fn unit tests (the spec deliverable)

`tests/game/exploration.test.ts` (31 cases) exhaustively covers each kernel:
frontier found / min-distance gate / `maxTiles` cap / BFS-through-seen-passable-only
/ out-of-bounds / determinism; POI nearest-relevant / radius boundary / handled-skip
/ tie order; locked-door record / purge / refresh / idempotence; the stuck counter's
strict-`<` epsilon; and the `DwellTracker` arm/accumulate/escape/extra-progress/fire/reset
lifecycle.

### 3. Measurable stuck/wiggle gate (C4 "reduce wiggle", made falsifiable)

`tests/headless/ai-stuck-wiggle.test.ts` drives the real headless sim on a fixed
seed (6) for sword and baseball-bat, reduces the emitted `SimEvent` stream with
the already-unit-tested `summarizeEvents` aggregator, and asserts measurable
wasted-motion bounds: `outcome = victory`, `travelEfficiency > 0.7`,
`wigglePct < 12`, and no stuck/wiggle **episode** longer than a few seconds.
Baselines are sword `eff 0.94 / wiggle 2.4%` and bat `0.94 / 2.0%`, so the
thresholds carry wide margin and only trip on a real regression (a reintroduced
knockback chase loop or frontier freeze), not on normal combat kiting. Raw
`stuckPct` is deliberately **not** asserted — intentional in-range combat
strafing inflates the per-frame stuck flag (~26%) without any true deadlock, so
episode length and travel efficiency are the honest signals.

### 4. Lab coverage

`src/labs/bt-exploration-lab/` runs a tiny deterministic fog-of-war sim — no
Phaser, no ECS — wired directly to the four kernels: the C1 frontier target the
auto-walker chases, the C2 nearest-POI line, C3 doors that block the BFS and turn
red once remembered locked, and a live C4 `stuckFrames` / dwell readout with a
"Wiggle in place" toggle that makes the watchdog fire on demand.

## Consequences

### Positive

- The originally-scoped ITEM #3 deliverable (pure-fn unit tests + a lab over
  C1–C4) now exists, satisfying lab-gating intent for the exploration behaviour.
- The directives are testable and visualisable in isolation for the first time;
  C2 (POI seeking) and the C4 wiggle reduction are now provable, not asserted.
- Zero behaviour change: identical headless gate and unit results before/after.

### Negative

- A thin adapter layer (the class builds a `FrontierGrid` / `PoiCandidate[]` each
  call). The cost is negligible and buys genuine testability.

### Risks

- The delegation must stay faithful. Mitigated by the unchanged full unit suite
  plus the 36/36 headless gate acting as the behaviour-preservation oracle.

## Alternatives Considered

- **Leave the directives private and test the class behaviourally only.** That is
  what already existed and is precisely the gap the spec called out; it cannot
  unit-test the pure decision logic or visualise it in a lab.
- **Re-implement the kernels in the tests/lab.** A parallel implementation would
  drift from production and prove nothing about the real path. Delegation makes
  the tests cover the shipped code.
- **A watchdog-only "wiggle" story.** ADR 0020/0021 added recovery/fast-fail
  watchdogs; the review explicitly asked for a _measurable_ reduction. The
  `summarizeEvents`-based gate provides a falsifiable metric, not just a watchdog.

## Related

- ADR 0020 — projectile leading + in-AI quest-progress recovery watchdog and the
  `computeFloorProgressScore` fingerprint.
- ADR 0021 — Floor 1 room-reachability guarantee + headless gate stall fast-fail
  (the structural blocker ITEM #3 surfaced).
