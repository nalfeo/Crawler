# Hunting grounds — where waste hides in Crawler

A catalog of the places in this codebase where gameplay-neutral waste has
historically lived or is structurally likely. Start here instead of guessing.
Each entry names the surface, the pattern to look for, and the neutrality risk.

Every candidate is still subject to the contract: measure it, then prove the
fingerprint is unchanged.

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
escapes the frame is a correctness disaster. Make reuse strictly local.

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

**Risk:** **zero gameplay risk** (rendering can't feed the sim — that's the whole
point of the bridge pattern), but real _visual_ risk. This is the safest
category for gameplay neutrality and the one where visual verification matters
most: observe the running game, not just the fingerprint.

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
