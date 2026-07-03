# ADR 0024: Floor 1 spawn density via a director engagement budget

## Status

Accepted

## Date

2026-06-25

## Estimated Complexity

🍎 x 4 — reworks one gameplay system (the Floor 1 enemy director) plus its data
schema and tests; no new lab and no core-AI changes.

## Context

Floor 1 is meant to feel like a vampire-survivors-like: while exploring the
dungeon the player should be under near-constant attack. In practice, moving
quickly across the map left the player with **no enemies to fight**.

The root causes all lived in `floor1EnemyDirectorSystem`
(`src/game/floorScenario.ts`) — the system Floor 1 actually uses. (The generic
`enemySpawnerSystem` is lab-only and does not drive Floor 1 gameplay.)

- **Global cap of 14.** The whole floor could only ever hold 14 ambient enemies.
- **One spawn per 900 ms.** A single enemy trickled in per interval, so the field
  could never keep up with a player who kept moving.
- **Flat despawn at 1920 px.** Trailing mobs were pruned the instant the player
  outran them, draining the field from behind faster than it refilled ahead.
- **Rooms started empty.** Nothing pre-populated a room, so entering a fresh
  combat room was silent until the slow trickle caught up.

The player asked for: a higher total cap (≈100) with a **separate** limit on how
many enemies are actively pursuing/engaging; a despawn rework that frees room to
spawn closer to the player; and a high chance that entering a room for the first
time means walking into a wave that is already there.

## Decision

Adopt a **director-side "engagement budget"** model. All behaviour stays in the
Floor 1 director and is fully data-driven from `enemies.floor1.json`. There are
**no core-AI changes** — enemy behaviour, pathing, and aggro are untouched.

Two independent budgets replace the single cap:

1. **Global cap (`enemyCap = 100`)** — the hard ceiling on ambient enemy entities.
   This fills the dungeon so distant rooms stay populated and pre-population is
   affordable.
2. **Engagement target (`engageTarget = 6` within `engageRadiusPx = 720`)** — the
   desired number of enemies actively engaging the player. Each interval
   (`spawnIntervalMs = 500`) the director counts living enemies inside the engage
   ring and **burst-spawns** up to `maxSpawnsPerTick = 3` near the player to top
   the count back up to the target. This guarantees a steady swarm even when the
   player outruns the field — there are no dead zones.

Supporting mechanics:

- **Recycle-at-cap despawn.** When the field is already at the global cap and the
  player needs closer threats, the director evicts the **furthest** stragglers
  that are _outside_ the engage ring (furthest-first) to free budget for fresh
  near spawns. Enemies inside the ring — the fight the player is actually in — are
  never recycled, and bosses/quest enemies are never touched. The flat far-prune
  distance was also relaxed (`despawnDistancePx = 1920 → 2400`) so rooms behind
  the player stay populated longer.
- **Room pre-population.** The first time the player stands inside a NORMAL combat
  room, the director rolls `roomWaveChance = 0.65` to seed a wave of
  `roomWaveMin..roomWaveMax = 2..3` enemies already inside, kept at least
  `FLOOR_1_ROOM_WAVE_MIN_PLAYER_DISTANCE_PX = 96 px` from the player so the wave
  reads as "already there" rather than materialising on top of them. The room id
  is recorded on first visit regardless of the roll, so leaving and re-entering
  never re-rolls. SPAWN, SAFE, and BOSS_STAIR rooms are never seeded.

The tuning values above were **calibrated against two headless gates**. The Floor
1 completion gate (`tests/headless/floor1-completion.test.ts`) runs seeds 6/2/5 ×
sword/bow/baseball-bat and asserts an honest clear within the 5-minute budget; the
stuck/wiggle gate (`tests/headless/ai-stuck-wiggle.test.ts`) drives seed 6 ×
sword/baseball-bat and asserts the AI never falls into a sustained oscillation
loop (`wigglePct < 12`, longest wiggle episode `< 5 s`, travel efficiency `> 0.7`).
An initial aggressive pass (`engageTarget 22`, `maxSpawnsPerTick 5`, `roomWaveChance
0.7`, waves of 3–6, `spawnIntervalMs 400`) was too brutal: the bow runs were
swarmed at spawn and died around 24 s at level 0. Dialing the engagement target to
8 let every combo clear, but the denser melee crowd then tripped the wiggle gate
(seed 6 · sword wiggled 21.8 % of the run with a 5.25 s episode). The final values
(`engageTarget = 6`, `roomWaveChance = 0.65`, waves of 2–3) clear every completion
combo comfortably (bow seeds clear in ~140–165 s, level 5–6) **and** keep the
worst-case wiggle well inside the gate (seed 6 · sword ≈ 5.6 %, longest episode
≈ 0–1.5 s) while the floor still reads as a constant-pressure swarm.

Determinism is preserved: all randomness flows through `world.rng`, the
pre-population roll consumes no rng for non-NORMAL rooms (a role check precedes
the chance roll), and same-seed worlds spawn identically.

## Consequences

### Positive

- Constant combat: the engagement budget keeps a swarm on the player no matter how
  fast they move, delivering the intended vampire-survivors feel.
- Entering a new combat room usually means walking straight into a fight.
- The global cap and the engagement target are decoupled, so the dungeon can be
  densely populated without making the near-player pressure unbounded.
- Despawn now frees budget for _closer_ spawns instead of just deleting trailing
  mobs, eliminating the "moved too fast → empty map" failure.
- Fully data-driven and deterministic; no new core-AI surface area.

### Negative

- Floor 1 is meaningfully harder and busier. The tuning values are a starting
  point and will likely need balance passes.
- A higher entity ceiling raises the per-frame cost of enemy systems; 100 ambient
  enemies is the new worst case to budget against.

### Risks

- Balance/health regression gates may flag the higher density; values may need to
  come down if Floor 1 reads as too brutal.
- In cramped start-room geometry the engage ring can be only partially fillable;
  the director compensates by flooding toward the global cap, which is bounded but
  denser than a perfectly concentrated swarm.

## Alternatives Considered

- **Hard pursuer cap gated in core AI.** Track and clamp the number of enemies in
  the "pursue/engage" AI state. Rejected: it bleeds spawn-density policy into core
  AI, risks determinism and lab regressions, and is far riskier than a
  director-side budget. The engagement target achieves the same player-facing goal
  ("≈N enemies on me at once") without touching AI.
- **Just raise the cap / lower the interval.** Bumping `enemyCap` and shrinking
  `spawnIntervalMs` alone does not fix fast movement (still one-at-a-time, still
  flat-pruned) and does nothing for empty rooms. The burst + recycle + pre-pop
  trio is what removes the dead zones.
- **Continuous room population (spawn while occupied).** Re-seeding rooms on every
  visit was rejected as non-deterministic-feeling and prone to runaway counts; a
  one-time roll recorded per room keeps it predictable.

## Follow-up (2026-06-26): shared flow-field pathfinding + diagonal movement

### Estimated Complexity

🍎 x 5 — a new core pathfinding primitive, an enemy-AI integration with a subtle
steering-oscillation fix, two lab visualisations, and a re-calibration against the
headless gates.

### Context

The "Negative / Risk" above came true: at `enemyCap = 100`, every ground chaser
ran its **own** A\* search toward the player almost every time anyone crossed a
tile boundary. In dense ranged fights with a kiting player that re-derived the
same routing data dozens of times per frame — the dominant CPU cost — and it blew
the headless wall-time perf guard.

### Decision

Replace per-enemy A\* for the common case with a **shared single-source flow
field** (`src/core/map/flow-field.ts`), the standard swarm/bullet-hell technique:

- **One BFS per frame** sweeps outward from the player's tile, computing the
  shortest-path tile distance to every reachable tile (`computeFlowField`). It is
  rebuilt only when the goal tile or door layout changes, and shared by every
  ground chaser that frame.
- Each ground chaser then takes an **O(1) gradient step** (`flowFieldStep`) to the
  most-downhill neighbour instead of searching. N A\* searches collapse into one
  BFS plus N trivial lookups. Pursuit stays exactly as tight as per-enemy A\* (it
  is the same shortest-path data), with none of the staleness of "re-path less
  often" hacks.
- **Ranged standoff, flanker, and flying** mobs keep per-enemy A\* — their targets
  are not the player's tile, so they cannot share the field.

**Diagonal movement.** The BFS distance field stays cheap 4-connected, but
`flowFieldStep` descends over **8 neighbours** (cardinals first for deterministic
ties, then diagonals) with a corner-cut guard — a diagonal is eligible only when
both orthogonally adjacent cells are reachable, so a chaser never clips a wall
corner. In open space a diagonal toward the goal is strictly more downhill than
either cardinal, so chasers glide along clean diagonal lines instead of
stair-stepping; due-N/E/S/W goals stay cardinal. This restores the diagonal
movement the pre-flow-field A\*+string-pulling produced.

**Steering oscillation fix.** Naively aiming a continuous-space chaser at the
_centre_ of a diagonal neighbour tile makes its heading depend on sub-tile
position and flip whenever it drifts across the shared corner into an orthogonal
tile. In a dense swarm that oscillates mobs in place, churning into a blockade
that pins the player. `followFlowField` therefore steers **diagonal** steps along
the pure gradient direction (constant within a tile) while keeping **cardinal**
centre-seeking (which gently re-centres mobs on the tile lane and matches the
validated baseline).

### Validation (before / after)

Measured on the headless gate suite (`npm run test:headless`, 53 tests):

- Diagonal stepping with naive centre-steering **failed** the gates: the suite
  took **176 s**, seed 6 · bow blew the wall-time guard at **100 s**, and seed 6 ·
  sword wiggled for an **86.75 s** episode (pinned by the oscillating swarm).
- After the direction-steering fix the suite runs in **~62 s** with **all 53 gates
  green** and the wiggle/perf metrics back at baseline — diagonal movement with no
  regression. Prior-segment profiling of the cardinal field showed seed 6 · bow
  dropping ~24 s → ~18 s with A\* call volume down ~3.6×.

### Lab visualisation

Both movement labs gained a **default-off** flow-field overlay so the field is
inspectable: a hot→cool distance heatmap, per-tile **diagonal arrows** straight
from `flowFieldStep`, and a goal marker.

- `src/labs/ai-runner-lab/` — Phaser overlay on the live Floor 1 sim.
- `src/labs/pathfinding-lab/` — canvas-2D overlay; its stale "Show Mob Paths" A\*
  overlay was relabelled "Show A\* Paths" (accurate for flankers/flying/ranged)
  now that ground chasers follow the flow field.

`flow-field.ts` is a pure core utility (no rendering/ECS/game imports), unit-tested
in `tests/ecs/flow-field.test.ts` (door routing parity with A\*, diagonal descent,
straight-diagonal travel, and corner-cut prevention); like `pathfinding.ts` it is a
primitive, not an ECS system, so it needs no lab of its own.

## Follow-up (2026-07-02): combat hit-detection broad-phase + engagement-budget validation

### Estimated Complexity

🍎 x 4 — a behaviour-preserving optimisation of **both** combat hit-detection
systems (melee **and** beam), plus the `knockbackSystem` realized-displacement
bound the beam broad-phase depends on, two permanent multi-frame differential
determinism regression tests (+ headless full-pipeline guards), and A/B benches at
Floor-2 scale. No gameplay change, no new lab (pure optimisation of existing
systems), no core-AI change. Delivered as one combined PR (Path A) under the full
4🍎 harness: dual-plan synthesis + separate-model plan review + code-review loop +
multi-model review.

### Context

The `enemyCap = 100` ceiling (and Floor 2's larger territories) makes the
per-frame cost of the combat hit-detection systems the next thing to budget
against. `meleeSwingSystem` and `beamSystem` both resolved hits by scanning
**every** `[Health, Position]` entity each swing/frame (O(swings × entities)) — a
full linear scan that ignores the `SpatialHashGrid` the collision stage already
builds and threads to `areaDamageSystem`/`trapSystem` via `collisionResult.grid`.

### Decision

Convert combat hit-detection to a spatial-hash **broad-phase**, reusing the
existing grid (the exact pattern `areaDamageSystem` uses), as a strictly
**behaviour-preserving, identical-by-construction** optimisation — both hit-detection
systems in one combined PR (Path A):

- **Melee.** `meleeSwingSystem(world, collisionResult?)`
  narrows candidates via `grid.queryRadius(cx, cy, R)` where `R` is a proven
  **superset** of the exact swing hit region (`bladeLength + max(BLADE_HIT_HALF_WIDTH,
headRadius) + EPS`, attacker-centred). The unchanged legacy narrow-phase
  predicate is then applied to the superset. Melee is provably **grid-staleness-free**:
  nothing translates entity positions between the grid build (`collisionSystem`)
  and the melee stage, so the grid is fresh and no knockback-margin term is needed.
- **Beam.** `beamSystem(world, collisionResult?)` narrows candidates via
  `grid.queryRadius(cx, cy, R)` from the beam **midpoint**, where
  `R = halfLength + BEAM_HIT_HALF_WIDTH + world.maxKnockbackStepThisFrame + EPS`.
  Unlike melee, the beam runs **after** `knockbackSystem`, so the grid is **stale** by
  up to one knockback step: `knockbackSystem` now resets and accumulates
  `world.maxKnockbackStepThisFrame` as the **realized** per-entity displacement
  (`hypot(finalX-oldX, finalY-oldY)`, max across entities) measured _after_ the final
  clamped position write — writer-agnostic (covers all three Knockback writers
  and `castPulseShield`) and clamp-aware. Inflating `R` by that bound keeps
  `queryRadius(R)` a guaranteed superset of the exact segment hit region even
  though entities moved after the grid was built. The unchanged legacy beam
  narrow-phase is then applied to the superset.

**Determinism invariant (the #1 risk).** `applyDamage` draws `world.rng.next()` per
qualifying hit (crit for enemy targets, dodge for player targets) _before_ HP is
computed, and hit events are emitted in processing order — so **target processing
order is determinism-observable**. Reordering hits would change the RNG draw
sequence and silently break the 90% Floor-1 seed win-rate gate. Three properties
keep the result identical to the legacy scan:

1. **Superset broad-phase** — `queryRadius(R)` ⊇ legacy candidates (uses
   `circleIntersectsAabb`, over-inclusive → safe). `EPS = 1e-3` dominates float32
   ULP at Floor coordinate scale (`|coord| < ~8.4e3 ft`), covering the quantised
   centres `queryRadius` reads from a `Float32Array`.
2. **Unchanged narrow-phase** — the exact legacy predicate/LoS/hit-once/immunity
   logic is applied untouched.
3. **Preserved iteration order** — a **lazy, once-per-frame canonical rank map** (bitecs
   dense-array order of `query([Health, Position])`, built on the first gate-passing
   swing/beam so beam-absent / tick-gated frames do **zero** scan) re-sorts
   broad-phase candidates into legacy order. Verified safe because neither
   `meleeSwingSystem`, `beamSystem`, nor `apply-damage.ts` mutates the
   entity/component set mid-invocation (`dropSystem`, the only combat-seam spawner,
   runs _after_ beam in both pipelines), so the dense order is stable within the call
   and the once-per-frame map is identical to legacy's per-swing/per-beam re-query
   order. An **executable fallback** to the full scan runs when the grid is absent or
   any `[Health, Position]` entity lacks a `Sprite` (⇒ not grid-indexed) — not a
   comment, a real prod branch that is also the differential-test oracle and the
   A/B-bench legacy driver.

### Validation (before / after)

- **Permanent differential determinism regression tests** (rule #10). Multi-frame
  lockstep: two identically seeded `createTestWorld({ seed })` worlds — one grid
  broad-phase, one no-arg full scan — stepped together, asserting byte-identical
  `Health`, `Position`, `world.combatEvents`, `world.skillUsageEvents`, and the
  **exact `SeededRandom` cursor** every frame, plus a per-frame no-mutation/subset
  invariant guard so a future on-hit component add/remove can't silently break
  rank-map stability without a red test:
  - **Melee** (`tests/ecs/melee-broadphase-determinism.test.ts`): 30 seeds × 12
    frames + boundary/fallback units (empty grid, exact-radius/head-hit boundary,
    superset-rejected, zero-reach, spriteless-Health fallback, non-combat-entity
    filter).
  - **Beam** (`tests/ecs/beam-broadphase-determinism.test.ts`): 30 seeds × 12 frames
    over a scrambled enemy cluster + boundary/fallback units (no targets, half-width
    hit, superset-reject, far-outside, Float32-boundary, zero-length, spriteless-Health
    fallback, non-combat entity, idle no-op) + a **knockback-staleness witness** that
    proves the `maxKnockbackStepThisFrame` inflation term is load-bearing (a real hit
    is missed by the bare radius but recovered by the inflated one, at parity with the
    full-scan oracle).
  - **Headless full-pipeline guards**
    (`tests/headless/{melee,beam}-broadphase-pipeline-determinism.test.ts`): drive the
    REAL `runSimulationStep` grid-vs-forced-fallback (`meleeBroadPhase` /
    `beamBroadPhase` seam) and assert byte-identical `RunStats`, so a future
    target-moving/target-spawning system inserted into the `collision → melee/beam`
    seam trips the guard.
- **A/B benches, same PR** (`tests/bench/core-systems.bench.ts`): legacy full scan
  vs grid broad-phase over identical Floor-2-scale scenes (180 enemies; 6
  simultaneous swings / 6 simultaneous beams), for both melee and beam. In the
  realistic _spread_ scene (the target) grid is **~4×–6× faster for melee** and
  **~2.4×–4.7× faster for beam**; a beam **idle** frame (all beams tick-gated) is at
  **parity** (the lazy rank-map build adds zero cost when no beam gathers). In a
  pathological _all-clustered_ worst case grid is within ~20% (melee) / ~1.5–1.9×
  (beam) of legacy — the sort/copy overhead isn't amortised when every entity shares
  a cell — i.e. a large win where it matters and no catastrophic regression at the
  extreme (the engagement budget caps active enemies at ~6 near any weapon, so the
  clustered extreme does not occur in real play).

### Engagement budget (this ADR's model) — validated, no change

The director engagement budget defined above (`enemyCap = 100`,
`engageTarget = 6` @ `engageRadiusPx = 720`, burst `maxSpawnsPerTick = 3`,
recycle-at-cap) was re-confirmed as the active, sole enforcement of active-set
density. This follow-up **validates** it holds at Floor-2 spawn scale via the
extended benches; **no gameplay/tuning change** was made.
