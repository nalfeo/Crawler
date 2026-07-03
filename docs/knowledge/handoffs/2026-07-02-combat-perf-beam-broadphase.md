# Session Handoff: Combat perf — beam+knockback spatial-hash broad-phase (combined melee+beam, 4🍎)

## Date

2026-07-02

## Persona(s) adopted

**Systems Engineer** (`docs/agent-os/personas/systems-engineer.md`). Deterministic
ECS hot-path optimization of combat hit-detection with a hard
identical-by-construction requirement — squarely systems/engine work.

## Routing verdict

✅ right persona — a pure-`src/core` deterministic-simulation optimization is the
Systems Engineer's core beat.

## Apples

Estimated: 🍎 x 4 <!-- combined melee+beam branch; Path A folded beam+knockback into PR #678 -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — the melee half (shipped first) was 3🍎; folding in the beam
conversion + its unique **knockback-staleness** hazard (grid built before
`knockbackSystem` moves entities, so the beam superset radius must absorb one
realized knockback step) + the full >3🍎 harness (dual-plan synthesis +
multi-model review) brought the combined branch to 4🍎.

## Summary

Converted **both** combat hit-detection systems — `meleeSwingSystem` (shipped
earlier this branch) and now `beamSystem` — from full `query([Health, Position])`
scans to spatial-hash `grid.queryRadius(cx, cy, R)` broad-phase, reusing the grid
`collisionSystem` builds each frame (the exact pattern `areaDamageSystem` uses).
This is a **behavior-preserving, identical-by-construction** optimization: same
hit set, same damage numbers, same gameplay outcomes, byte-identical across seeds.

The beam half adds one hazard the melee half didn't have: the grid is **stale**
for beam because `knockbackSystem` runs between the grid build and `beamSystem`
and translates entity positions. Handled by measuring the **realized** knockback
displacement (post-clamp) into a new authoritative world bound
`world.maxKnockbackStepThisFrame` and inflating the beam superset radius by it, so
the broad-phase provably still returns a superset of the true narrow-phase hit
set.

## The determinism invariant (identical-by-construction)

`applyDamage` (`src/core/apply-damage.ts`) draws `world.rng.next()` per qualifying
hit (crit for enemy targets, dodge for player) **before** HP is computed, and
`emitWeaponHitSkillEvents` pushes in hit order. So **target processing order is
determinism-observable** — reorder hits ⇒ change crit/dodge draw order ⇒ change
kills ⇒ break the 90% Floor-1 seed win-rate gate.

Preserved by three properties, proven by permanent differential tests:

1. **Superset broad-phase.** `grid.queryRadius(cx, cy, R)` returns a SUPERSET of the
   legacy candidates. Melee: `R = reach + BLADE_HIT_HALF_WIDTH + EPS` (grid fresh).
   Beam: `R = halfLen + BEAM_HIT_HALF_WIDTH + maxKnockbackStepThisFrame + EPS`
   (grid stale ⇒ +1 realized knockback step).
2. **Unchanged narrow-phase.** The exact legacy per-target predicate is applied
   byte-for-byte to the broad-phase candidates.
3. **Preserved iteration order.** A once-per-frame canonical rank map
   (`rank[eid] = dense-array index of query([Health,Position])`) re-sorts survivors
   into the exact order legacy used. Verified precondition: neither system nor
   `apply-damage.ts` adds/removes entities or the `Health` component mid-invocation
   (`apply-damage.ts` imports only `hasComponent`/`query`), so the set + dense order
   are stable within one invocation ⇒ the once-per-frame map is provably identical
   to legacy's per-swing/per-beam re-query order. Only combat-seam spawner
   (`dropSystem`) runs AFTER beam in both pipelines.

An executable **full-scan fallback** (not a comment) triggers when any
`[Health,Position]` entity lacks `Sprite` (⇒ not in the grid), preserving legacy
behavior for sprite-less worlds.

## Observe before/after (rule #10) — deterministic proof + perf

**Behavior (deterministic, permanent tests):**

- `tests/ecs/beam-broadphase-determinism.test.ts` (NEW) — multi-frame lockstep
  differential: grid-driven world vs legacy full-scan reference, seeded identically,
  asserts byte-identical `Health.current`, combat/skill events, positions, and RNG
  state each frame across many seeds; plus boundary/EPS, empty-grid, sprite-less
  fallback, and a **knockback-witness** case (a beam that only hits its target
  because a knockback step moved it — proves the `+maxKnockbackStepThisFrame` term
  is load-bearing). Non-vacuous grid-path guard asserts `hasComponent(target, Sprite)`.
- `tests/headless/beam-broadphase-pipeline-determinism.test.ts` (NEW) — drives the
  REAL full pipeline grid-vs-forced-fallback across contiguous seeds; byte-identical
  RunStats.
- Melee equivalents (`tests/ecs/melee-broadphase-determinism.test.ts` +
  `tests/headless/melee-broadphase-pipeline-determinism.test.ts`) retained + their
  invariant guards hardened to real `hasComponent` membership.

**Perf (`npm run bench`, legacy-vs-grid A/B in the SAME PR):**

| Scene (180 enemies)                    | legacy hz | grid hz   | ratio            |
| -------------------------------------- | --------- | --------- | ---------------- |
| beam — Floor-2 spread, 6 beams (hl)    | 10,015    | 47,341    | **~4.7× faster** |
| beam — Floor-2 spread, 6 beams (e2e)   | 9,097     | 21,581    | **~2.4× faster** |
| beam — idle tick-gated (lazy build)    | 1,128,238 | 1,151,052 | ~1.0× (parity)   |
| beam — dense worst-case (24ft cluster) | 4,554     | 2,416     | ~0.53× (slower)  |
| melee — Floor-2 spread (re-confirmed)  | 7,055     | 29,328    | ~4.2× faster     |

The dense worst-case is slower by design (when the query radius ≈ the whole set,
the sort+copy is pure overhead) — an honest, documented tradeoff identical in shape
to melee's dense bench. **ADR 0024's engagement budget (≤6 active enemies @ 720px)
prevents this pathological all-clustered-in-range case in real Floor-1/2 play**, so
the realistic-spread win is what ships. Idle frames are parity because the rank map
is built lazily only when a beam actually fires.

## Engagement budget (ADR 0024) — VALIDATE only, no gameplay change

Verified ADR 0024's budget IS implemented (director: `enemyCap`, `engageTarget=6` @
`engageRadiusPx=720`, spawn-interval + recycle-at-cap in
`floorScenario.ts`/`floor-config.ts`/`enemies.floor1.json`). This branch VALIDATES
it holds at Floor-2 spawn scale via the extended benches; **no gameplay change, no
new budget system built** (would have needed human sign-off — not required).

## Files changed (uncommitted at time of writing; about to commit)

- `src/core/world.ts` — `maxKnockbackStepThisFrame` field + init 0.
- `src/core/systems/knockbackSystem.ts` — reset at top; realized-displacement
  (`Math.hypot(finalX-oldX, finalY-oldY)`) accumulate-max after the final clamped
  write (writer-agnostic, clamp-aware).
- `src/core/systems/beamSystem.ts` — full grid broad-phase conversion
  (`BEAM_HIT_HALF_WIDTH`, `BEAM_BROAD_PHASE_EPS`, gen-stamped rank-map helpers,
  `beamSystem(world, collisionResult?)`, lazy build + midpoint-circle superset
  gather, byte-identical narrow-phase, scratch-copy of the reused queryRadius buffer).
- `src/core/systems/meleeSwingSystem.ts` — eager→lazy rank-map refinement.
- `src/game/ai/simulation-step.ts` — `beamBroadPhase`/`meleeBroadPhase` flags on
  `SimulationOptions`; beam callsite threads the grid (argument-only, **no reorder**).
- `src/engine/sim/simulation-step.ts` — `beamSystem(world, collision)` + determinism
  comment block (**no reorder**).
- `tests/ecs/beam-broadphase-determinism.test.ts` (NEW),
  `tests/headless/beam-broadphase-pipeline-determinism.test.ts` (NEW).
- `tests/ecs/melee-broadphase-determinism.test.ts` — hardened invariant guard.
- `tests/bench/core-systems.bench.ts` — beam A/B benches (3 describe blocks).
- `docs/knowledge/adr/0024-floor1-spawn-density-engagement-budget.md` — follow-up
  section extended to 4🍎 combined melee+beam.
- `docs/knowledge/review-ledgers/2026-07-02-combat-perf-engagement-budget.review-ledger.json`
  — `multi_model_review` + `code_review` round 3 recorded; valid 4🍎 ledger.

## Review harness (4🍎) — all stages recorded + validated

- **dual_plan_synthesis** ✅ — gpt-5.4 + gemini-3.1-pro-preview planners, claude-opus-4.8 judge.
- **plan_review** ✅ — gpt-5.5, 7 concerns, all resolved.
- **multi_model_review** ✅ — 3 distinct models (gpt-5.3-codex, gemini-3.1-pro-preview,
  gpt-5.5) reviewed the beam+knockback delta; all clean; claude-opus-4.8 adjudicated → 0 valid concerns.
- **code_review** ✅ (loop closed clean) — rounds 1–2 (claude-sonnet-4.6, melee) clean;
  **round 3 (claude-sonnet-4.6, beam delta) caught ONE MAJOR test-integrity defect the
  multi-model round missed**: the grid-path-exercised invariant guard in both
  determinism tests was VACUOUS (`stores.sprite.width[eid]` on a Float32Array never
  returns `undefined`). RESOLVED by asserting `hasComponent(world.ecs, target, Sprite)`;
  re-verified (both suites green, guard now genuinely non-vacuous).
- `npm run review:ledger -- validate …` → exit 0 (valid 4-apple ledger).

## Cross-session coordination

- Parallel **Status-effect framework** session (`90b5a4da`) moved `statusEffectSystem`
  after `enemyAISystem` and edits `src/game/ai/simulation-step.ts` +
  `src/bootstrap/floor-main-scene-options.ts`. Knockback ownership **CLEARED** for me
  (their finalized plan does NOT touch `knockbackSystem.ts`).
- File-level overlap only on `src/game/ai/simulation-step.ts` (my callsite-arg change
  vs their system insert — different hunks ⇒ likely clean 3-way merge). Their insert
  updates effect sets + HoT health but does **not** move entities, so it doesn't disturb
  my grid-build→beam window.
- **Merge-order protocol:** whoever merges SECOND rebases onto clean main and re-runs
  the full win-rate gate + my differential tests before arming merge.

## Next steps / open items

- Commit (conventional `perf(core):`) + push to PR #678; retitle PR to synthesize the
  whole combat-perf branch (melee + beam broad-phase) per rule #11.
- Report to Floor-2 orchestrator (`fadd8cd5-…`); await explicit merge authorization
  (do NOT arm `gh pr merge` unilaterally).

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl` (note: this file contains
synthetic guard-**test** fixture events — guard names `boom`, `ctx-a`, `pr-a`, etc.
— not real session guard activity).

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 47,
  "guards": {
    "boom": { "crash": 6 },
    "ctx": { "allow": 3 },
    "ctx-a": { "allow": 3 },
    "ctx-b": { "allow": 3 },
    "edit-bad": { "bypass": 3 },
    "edit-guard-self-protection": { "ask": 6 },
    "pr-a": { "deny": 3 },
    "pr-b": { "deny": 3 },
    "pr-hard": { "deny": 3 },
    "pr-preflight": { "allow": 1 },
    "pr-review-ledger": { "allow": 1 },
    "pr-warn": { "allow": 3 },
    "shell-a": { "deny": 3 },
    "shell-bad": { "deny": 6 }
  },
  "tools": { "create_pull_request": 14, "edit": 18, "powershell": 15 }
}
```
