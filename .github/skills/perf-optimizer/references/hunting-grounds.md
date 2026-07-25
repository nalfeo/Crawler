# Hunting grounds — where waste hides in Crawler

A catalog of the places in this codebase where gameplay-neutral waste has
historically lived or is structurally likely. Start here instead of guessing.
Each entry names the surface, the pattern to look for, and the neutrality risk.

Every candidate is still subject to the contract: measure it, then check the
fingerprint is unchanged — and for render/load candidates, add the
surface-specific observation the fingerprint cannot give you.

---

## Measured sim profile (starting hints only)

The real ranked cost of a headless Floor 1 run. This is a **starting hint, not a
target list** — it goes stale as the code changes.

**Re-profile before choosing anything from it** (`npm run perf:profile`, ~35s).
The numbers below are also inflated ~1.12x by Node/tsx startup, which is a fixed
cost of the harness rather than game work.

- **Captured:** 2026-07-25 at commit `30d39bfd1`
- **Command:** `npm run perf:profile -- --top 18` (default panel: seeds 1-3 x
  sword, full runs)
- **Sample:** 3 runs, ranked by self time, `timeDeltas` timing source

| self%  | total%     | function                           | location                                 |
| ------ | ---------- | ---------------------------------- | ---------------------------------------- |
| 21.52% | 24.28%     | `compute` (FOV shadowcasting)      | `rot-js`, via `fovSystem.ts:76`          |
| 5.20%  | 5.28%      | `hasClearLineOfSight`              | `src/game/ai/bt-ai-geometry.ts`          |
| 4.37%  | 4.40%      | `computeFlowField`                 | `src/core/map/flow-field.ts`             |
| 4.30%  | 17.91%     | `planObjectiveRoute`               | `src/game/ai/objective-route-planner.ts` |
| 2.54%  | 2.54%      | (garbage collector)                |                                          |
| 2.18%  | 2.47%      | `floodReachabilityDepth`           | `src/game/ai/bt-ai-provider.ts`          |
| 1.96%  | **26.31%** | `findTilePath`                     | `src/core/map/pathfinding.ts`            |
| 1.69%  | 1.69%      | `insert`                           | `src/core/collision.ts`                  |
| 1.68%  | 3.49%      | `_castVisibility` (FOV internals)  | `rot-js`                                 |
| 1.29%  | 1.32%      | `computeEffectiveStatsFromLoadout` | `src/core/effective-stats.ts`            |
| 1.09%  | 2.41%      | `applyEffectiveStats`              | `src/core/effective-stats.ts`            |

Two things this table is here to teach:

- **`findTilePath` is 1.96% self but 26.31% total.** It is the most expensive
  subsystem in the simulation and it is nearly invisible if you rank by self time
  alone. Always read both columns.
- **`compute` (FOV) is ~21% self and runs every frame** from `fovSystem.ts:76`,
  while visibility only changes when something moves or a door opens — the
  textbook A1 shape. Meanwhile the pair of `effective-stats` entries totals
  ~2.4%, and that pair is what the agent's first run optimized. A 3x win there
  was capped at ~1.9% before a line was written.

---

## A. Steady-state frame time

### A1. Per-frame recomputation of event-driven values

**Where:** the ECS system pipeline — `src/core/systems/`, driven by
`src/engine/sim/simulation-step.ts` (game) and `src/game/ai/simulation-step.ts`
(headless).

**Pattern:** a system recomputes a derived value on every tick when the inputs
only change on an event (equip, level-up, floor load, door state change).
`statSystem`, `equipmentSystem`, and `questWaypoints` are the classic shapes:
derived aggregates that are stable between discrete events.

**Neutral fix:** cache keyed on the actual inputs, invalidate on the event.

**Risk:** a stale or under-keyed cache changes behavior. This is the single most
common way a "pure optimization" silently breaks the game. Key on everything the
computation reads — if you can't enumerate the inputs, don't cache it.

### A2. Broad scans that should be narrow-phase

**Where:** `collisionSystem`, `areaDamageSystem`, `beamSystem`,
`meleeSwingSystem`, `aoeOnImpactSystem`.

**Pattern:** iterating all entities to find the few in range. The repo already
has broadphase work for melee and beams (see the 2026-07-02
`combat-perf-melee-broadphase` and `combat-perf-beam-broadphase` handoffs, and
the `tests/headless/melee-broadphase-pipeline-determinism.test.ts` /
`beam-broadphase-pipeline-determinism.test.ts` parity gates) — follow that
precedent rather than inventing a new one.

**Neutral fix:** a spatial index that provably returns the **same set**, in the
**same order**, as the broad scan.

**Risk:** set-identical is not enough — **order** matters. If the damaged set is
iterated in a different order, damage application order changes, and with it the
RNG stream. The existing parity tests exist precisely because of this. Add an
equivalent parity test for any new broadphase.

### A3. Allocation churn in hot loops

**Where:** any per-frame system; especially vector math, path result arrays, and
event/telemetry object construction.

**Pattern:** `{x, y}` literals, `.map`/`.filter` chains, array literals, and
closures created per entity per frame. At hundreds of entities × 60 fps this is
real GC pressure and shows up as frame-time spikes, not average cost.

**Neutral fix:** scratch objects reused across iterations, index-based loops in
the hottest paths, preallocated result buffers.

**Risk:** low for behavior, **high for aliasing bugs** — a reused buffer that
escapes its intended lifetime is a correctness disaster that no test of the
optimized function itself will catch. A reentrancy guard is **not** sufficient:
it catches nesting, but not a returned alias, a stored reference, or async
retention across a frame boundary.

"Make it strictly local" is not always available — the measured 3x win in
`applyEffectiveStats` (PR #1973) required module-level scratch, because
function-local buffers reallocate per call and that was the cost being removed.

So pick and **name in the PR** one of these four mechanisms:

1. **Function-local** — the buffer never outlives the call. Free, always
   correct, but forfeits the win when per-call allocation _is_ the cost.
2. **Encapsulated non-escaping** — module/closure-level scratch that is provably
   never returned, stored, or captured. The proof is the enumeration: list every
   exit path from the function and show none of them hand out the buffer.
3. **Copy-on-return** — shared scratch internally, but the value handed back is a
   fresh copy. Keeps most of the win when the result is much smaller than the
   working set.
4. **Reentrancy/lease guard** — an explicit in-use flag in `try/finally` that
   throws on nested entry. Use this **in addition to** 2 or 3, never instead of
   them; it converts silent corruption into a loud, actionable failure.

Whichever you choose, add a regression test that would fail if the buffer
escaped — assert on a retained reference after a second call, not just on the
return value of one call.

### A4. Pathfinding

**Where:** `src/game/ai/` and the navmesh code.

**Pattern:** repeated searches for a result that hasn't changed. This repo's
worst recorded regression was exactly this: `resolveReachableGoalTile` re-ran a
ring of ~110–169 A\* searches **every poll** because the fallback was never
cached, taking the headless runner from <10s to ~58s — a ~30x blowup. See the
2026-06-25 `headless-runner-pathfinding-slowdown` handoff.

**Neutral fix:** cache the fallback/failure result, invalidate on the geometry or
goal changing.

**Risk:** high. Path results feed AI decisions directly; a different path is a
different game. The fingerprint is non-negotiable here.

**Note:** `tests/headless/floor1-completion.test.ts` carries a deliberately loose
wall-time ceiling (`HEADLESS_WALL_TIME_BUDGET_MS`) as a catastrophic-regression
guard. Do **not** tighten it toward observed runtimes to "capture" your win — the
comment there explains why that trades a real signal for CI flakes.

### A5. Rendering submission

**Where:** `src/engine/` — sprite/graphics updates in `MainGameScene` and its
helpers.

**Pattern:** setting properties that haven't changed, rebuilding graphics objects
per frame, per-frame texture or tint churn, redundant depth sorting.

**Neutral fix:** dirty-flagging, and skipping submission when nothing changed.

**Risk:** **zero pure-ECS simulation risk** (rendering can't feed the sim — that's
the whole point of the bridge pattern), but **nonzero player-facing risk**:
dirty-flagging can break attack telegraphs, depth ordering, input hit-areas
attached to display objects, and first-use hitches. The fingerprint is nearly
vacuous here — it never runs this code. Visual/e2e observation is the real gate:
`npm run review:visual` or a `ui-probe`/pixel assertion, plus the running game.

---

## B. Load time

### B1. Eager work on the critical path

**Where:** `src/engine/scenes/BootScene.ts`, `IntroScene.ts`, and the floor-load
path in `MainGameScene.ts` / `main-game-scene-helpers.ts`.

**Pattern:** work done before first frame that isn't needed for first frame —
parsing data for content the player can't reach yet, building indices for later
floors, decoding assets for scenes not yet entered.

**Neutral fix:** defer to first use, or move off the critical path.

**Risk:** low for gameplay, but a first-use stall is a worse experience than a
load stall. Measure the deferred cost too — don't just move the spike.

### B2. Assets loaded but unused

**Where:** the sprite manifest and atlas loading.

**Pattern:** loading the full asset set regardless of floor. Cross-check what a
scene actually references against what it loads.

**Neutral fix:** per-floor or per-scene asset scoping; lazy atlas loading.

**Risk:** a missing asset at runtime. Verify in the running game, on every floor
you touched.

### B3. Bundle size on the critical path

**Where:** the Vite build.

**Pattern:** modules pulled into the initial chunk that only matter later —
labs/dev-only code, rarely-used systems, large data blobs that could be fetched.

**Neutral fix:** dynamic import and code-splitting.

**Risk:** low. Confirm the split boundary doesn't break layer rules.

**Also:** `npm run lint:dead-code` and `VERIFY_KNIP=1 npm run verify` surface
genuinely unreferenced exports. Deleting dead code is the cheapest possible win
and is trivially gameplay-neutral — but check `npm run check:wired-systems`
before deleting anything named `*System`.

---

## C. Memory

### C1. Unbounded growth

**Pattern:** event logs, telemetry arrays, caches without eviction, and
per-entity maps never cleaned on entity death.

**Where to look:** anything that `push`es per frame or per event.

**Neutral fix:** bounded ring buffers, eviction, cleanup on entity removal.

**Risk:** if a log is read by gameplay, truncating it changes behavior. Confirm
the consumer is diagnostic-only before bounding it.

---

## Anti-patterns — reject these "optimizations"

| Tempting change                                    | Why it's rejected                              |
| -------------------------------------------------- | ---------------------------------------------- |
| Run a system every N frames instead of every frame | Changes simulation fidelity — design change    |
| Cap the entity/enemy count                         | Changes the game                               |
| Cheaper pathfinder that picks a different tile     | Different AI decisions — different game        |
| Skip distant entity updates                        | Simulation change, and it breaks determinism   |
| Lower the tick rate                                | The most fundamental gameplay change available |
| Loosen a tolerance so a test passes                | AGENTS.md r11 violation                        |

If a measurement says one of these is the only meaningful win available, that is
a legitimate and useful finding — report it to the human as a **design decision
to be made**, and do not land it yourself.
