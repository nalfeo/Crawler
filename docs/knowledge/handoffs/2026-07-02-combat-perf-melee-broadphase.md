# Session Handoff: Combat perf — melee hit-detection spatial-hash broad-phase

## Date

2026-07-02

## Persona(s) adopted

**Systems Engineer** (`docs/agent-os/personas/systems-engineer.md`). The task is a
deterministic ECS hot-path optimization (hit-detection broad-phase) with a hard
identical-by-construction requirement — squarely systems/engine work, not content
or tools.

## Routing verdict

✅ right persona — a pure-`src/core` deterministic-simulation optimization is the
Systems Engineer's core beat.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — the identical-by-construction design (superset grid query +
byte-identical narrow-phase + canonical rank-map to preserve legacy iteration
order) held exactly as scoped; the one late addition (full-pipeline guard test +
`meleeBroadPhase` seam) was a review-driven future-proofing item that stayed within
the 3🍎 envelope.

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

weapons

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-combat-perf-engagement-budget.review-ledger.json`
Stages (3🍎 tier): plan_review ✅ · code_review ✅ (dual-plan synthesis / multi-model
NOT required under 4🍎).
`npm run review:ledger -- validate <path>` → ✅ valid 3-apple ledger.

- **plan_review** — separate-model review by **gpt-5.4** (high effort) on the full
  beam+melee plan: 9 concerns (2 blocking, 3 major, 4 minor), all resolved. Scope
  then narrowed to **Path B (melee-only @ 3🍎)** by human decision; the 2
  beam-specific concerns (B1 actual-segment radius, B2 knockback-staleness margin)
  are resolved-by-design and **deferred to the beam fast-follow PR**. The 7
  melee-applicable concerns are all satisfied here.
- **code_review** — 2 rounds, both clean (project code-review agent,
  claude-sonnet-4.6). Round 1 (full conversion): no substantive defects; verified
  all 3 determinism properties, the no-mid-invocation-mutation precondition,
  aliasing/scratch-copy safety, capacity alignment, and the executable fallback.
  Raised ONE non-blocking future-proofing observation (unit differential test
  can't catch a future system inserted into the collision→melee seam). Round 2 (the
  fix delta): clean.

## What Was Done

Converted `meleeSwingSystem` hit-detection from a full-`[Health, Position]` scan to
a **spatial-hash `queryRadius` broad-phase**, reusing the frame's grid built by
`collisionSystem` (same pattern as `areaDamageSystem`). Behavior-preserving,
identical-by-construction.

Files touched:

- **`src/core/systems/meleeSwingSystem.ts`** — the conversion. Once-per-frame
  canonical rank map (gen-stamped `Int32Array`, sentinel `-1`) captures legacy
  bitecs dense-array iteration order + detects any `[Health,Position]` entity
  missing `Sprite` (→ not in grid) to flip an **executable full-scan fallback**
  (not a comment). Per swing: `grid.queryRadius(cx,cy,R)` with `R` = superset of
  the exact swing hit region; copy the reused query buffer to scratch; drop
  `rank === -1` sentinels (dev-assert + safe fallback); sort ascending by rank;
  run the **byte-identical** legacy narrow-phase (LoS, hit-once set, baby-slime
  immunity) on the ordered candidates. Superset ∩ identical predicate = identical
  hit set; preserved order = identical `world.rng` draw sequence.
- **`src/game/ai/simulation-step.ts`** — threads `collisionResult.grid` into the
  melee call; adds `meleeBroadPhase?: boolean` to `SimulationOptions` (default =
  grid) as a **determinism rollback / guard seam** (explicit `false` forces the
  legacy scan).
- **`src/engine/sim/simulation-step.ts`** — threads the grid into the melee call;
  added a determinism-invariant comment warning future editors not to insert a
  target-moving system into the grid-build→melee seam (this pipeline lacks the
  flag seam, so the comment + the headless guard test are its protection).
- **`tests/ecs/melee-broadphase-determinism.test.ts`** (NEW) — permanent unit-level
  differential regression: two identically-seeded worlds (grid vs legacy) stepped
  in lockstep over many frames × seeds, asserting byte-identical `Health`,
  `Position`, `combatEvents`, `skillUsageEvents`, per-swing hit-once set, and exact
  RNG cursor. Plus boundary/fallback units (zero-reach, exact-radius, empty grid,
  sprite-less-Health fallback, sentinel-survivor fallback). 8 tests.
- **`tests/headless/melee-broadphase-pipeline-determinism.test.ts`** (NEW) —
  permanent full-pipeline guard (rule #10): drives the REAL `runHeadless` pipeline
  twice per seed (grid vs forced fallback via the seam), `forceWeaponId: 'sword'`,
  asserting byte-identical `RunStats` (only `wallTimeMs` stripped) + non-vacuity
  (`combat.damageDealt > 0`). Closes the round-1 review observation: catches a
  future target-mover inserted into the collision→melee seam.
- **`tests/bench/core-systems.bench.ts`** — A/B benches (legacy full-scan vs grid)
  over identical Floor-2-scale (~180 enemies, multiple simultaneous swings) and
  pathological dense-clustered scenes.
- **`docs/knowledge/adr/0024-floor1-spawn-density-engagement-budget.md`** —
  appended a "Follow-up: combat hit-detection broad-phase + engagement-budget
  validation" section (amend, not a new ADR number — sidesteps the number-collision
  race; next-unused is 0041).

**Engagement budget (ADR 0024): VALIDATE only, no gameplay change.** Confirmed the
budget IS implemented in code (director `enemyCap`/`engageTarget`/`engageRadiusPx`

- recycle-at-cap). This PR validates it holds at Floor-2 spawn scale via the
  extended benches; no combat-feel change.

### Perf (measured this session, `npm run bench`)

Grid built once outside the measured loop; enemies at 1M HP (never die); crit
rolls exercised. Representative hz (higher = faster):

- **Floor-2-scale spread scene** (~180 enemies, 6 simultaneous swings) — the
  intended real-combat case, grid is a big win:
  - unit: legacy 9,908 hz → grid 39,854 hz = **4.02× faster**
  - integration: legacy 8,603 hz → grid 38,114 hz = **4.43× faster**
  - headless: legacy 3,465 hz → grid 27,547 hz = **7.95× faster**
  - e2e: **2.69× faster**
- **Pathological dense-clustered worst case** (~180 enemies all within one swing
  region) — near-parity, no catastrophic regression: legacy ~1.09×–1.29× faster in
  3 projects (grid's rank sort can't amortize when almost everything is a
  candidate), grid **1.19× faster** in e2e. Real Floor-1/2 combat is the spread
  case, so this is the win where it matters.

## What's Next

- **Beam fast-follow PR (HELD).** Convert `beamSystem` to the same grid broad-phase.
  Its one real hazard is knockback-staleness (the grid is one `knockbackSystem`
  step old by the beam stage), fixed in `knockbackSystem.ts` — movement-displacement
  surface adjacent to the parallel "Status-effect framework" session. **Blocked on
  the Floor 2 coordinator confirming knockback ownership** before opening. Plan-review
  concerns B1 (beam actual-segment radius, no unit-length assumption) and B2
  (authoritative knockback-staleness margin) apply there and are resolved-by-design.
- Once beam lands, both hit-detection hot paths use the shared grid pattern.

## Blockers

None for this (melee) PR. Beam follow-up is intentionally sequenced behind a
cross-session knockback-ownership confirmation (not a hard blocker for merging
melee).

## Branch State

- Branch: `nalfeo-data-driven-quest-packs` (rename tools were spent earlier in the
  session on the original quest-pack task; the branch name is stale. **PR
  title/description synthesize the whole branch as combat-perf work per rule #11.**)
- All tests passing: yes — `npm run verify` green through step 8 (unit 2860,
  integration 49, headless Floor-1 win-rate gate 19); PR-prereqs pass once this
  handoff exists; build is step 10.
- PR created: [to be created after this handoff + final verify]

## Agent-OS Telemetry

N/A — `files/guard-telemetry.jsonl` does not exist this session.

## Test Results

- `npm run verify:fast` → green (800 tests) after the conversion.
- `npm run verify` → typecheck ✅ · lint ✅ · format ✅ · unit **2860 passed** ✅ ·
  integration **49 passed / 1 skipped** ✅ · **headless Floor-1 gate 19 passed** ✅
  (the win-rate gate is unaffected — the optimization is identical-by-construction).
  Review ledger validates ✅. (Step 9 initially flagged the missing handoff — this
  file — which is expected.)
- New determinism tests: unit differential 8/8 ✅, full-pipeline guard 2/2 ✅.

## Key Decisions Made

- **Identical-by-construction over "close enough."** Because `applyDamage` draws
  `world.rng` per qualifying hit, hit ORDER is determinism-observable; the whole
  design protects it (superset query + unchanged narrow-phase + canonical rank map).
- **Path B (melee-only now, beam fast-follow).** Human decision: decouples the
  guaranteed-safe melee win from the beam's knockback-staleness hazard + the
  cross-session ownership question; smaller PRs merge cleaner.
- **`meleeBroadPhase` guard seam is a real ops/determinism seam, not test cruft.**
  It's the only way to force the legacy path through the full pipeline WITHOUT
  perturbing other grid consumers (removing a Sprite would drop the entity from the
  grid and diverge collision/areaDamage/trap/pickup for non-melee reasons).
- **ADR amend, not new number** — avoids the 0039→0040 renumber race #646 hit.
- **Culling/LOD stays OUT** — skipping updates changes the simulation (determinism
  risk); not pursued.

## Retrospective

### Lessons Learned

- The grid's `queryRadius` returns a **reused internal buffer** — you MUST copy to
  scratch before sorting/iterating, or a nested/re-entrant query corrupts your
  candidate list. This is the single easiest way to silently break the conversion.
- `runHeadless` already forwards `config.simulationOptions` into `runSimulationStep`
  (spread at ~L287), so a new `SimulationOptions` field is exercisable end-to-end
  through the real AI pipeline with **zero** changes to `runHeadless` — ideal for a
  full-pipeline determinism guard.
- `RunStats.wallTimeMs` is the ONLY nondeterministic field; `combatTimeMs` is
  `frames * DELTA_MS` arithmetic (verified by round-2 review), so stripping just
  `wallTimeMs` makes a full-`RunStats` `toEqual` a rock-solid determinism assertion.
- Disable the wall-clock terminator (`maxWallTimeMs: Infinity`) in a fixed-frame
  determinism harness — otherwise wall time (machine-variant) can stop the two runs
  at different frames and flake.

### Mistakes Made

- Two upstream premises for this session were **stale** (the quest loader was
  already built; the "3 sprite typecheck errors" didn't exist on main). Early
  signal: `npm run typecheck` was clean on first run. Lesson reinforced —
  **verify every handed-down premise with your own reads/commands before planning**;
  it saved a wasted rebuild.
- A stray repo-root `plan.md` (a stale pre-Path-B 4🍎 copy) was left around and had
  to be removed before it got committed. Watch for scratch files escaping the
  session folder.

### Opportunities for Future Improvement

- The A/B bench baseline (`docs/knowledge/metrics/bench-baseline.json`) is `{}`, so
  the 15% bench-regression gate has nothing to compare against — the same-PR A/B is
  currently the real gate. Worth capturing a committed baseline so future perf
  regressions trip `scripts/agent/health/bench-regression.ts` automatically.
- The two simulation pipelines (`src/engine/sim` and `src/game/ai/simulation-step`)
  are kept in sync by hand; a shared ordering assertion or a single source of truth
  for the system order would make the "verbatim extraction" claim enforceable rather
  than aspirational.
