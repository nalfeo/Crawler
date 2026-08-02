# Session Handoff: Floor 2 Slice 1 — Family data + factionRelations + system + lab

## Date

2026-07-02

## Persona(s) adopted

Producer → Systems Designer. This was foundation data + a small piece of
per-tick state, so the Systems Designer's bias toward invariants and tuning
knobs (bands, clamps, deterministic seeding) was the right shape.

## Routing verdict

✅ right persona — Slice 1 is pure data + pure helpers + one drain-loop system,
which is squarely Systems-Designer territory. No AI/animation work here that
would have wanted a different specialist.

## Apples

Estimated: 🍎 x 3
Actual: 🍎 x 3
Verdict: 🎯 Exact — spec + ADR made the surface area very well defined and the
sibling Slice 2 session correctly stayed out of these files.

Hello kitties: 3/5 = 0.60 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-03-floor2-slice1.review-ledger.json`
Stages: plan_review ✅ · code_review ✅
`npm run review:ledger -- validate <path>` → valid 3-apple ledger.

## What Was Done

- **Data (ADR 0011 pattern):** `src/shared/data/families.json` (18 families
  transcribed from `docs/knowledge/game-design/floor2-families-and-resources.md`)
  and `resources.json` (18 contested resources). Zod schemas + `loadFamilies()`
  / `loadResources()` in `families.ts` / `resources.ts` — id uniqueness,
  ≥15 families, 10–20 resources, hex `hudColor`, module-level cache.
- **Tuning:** added `factionRelations` block to `src/shared/data/tuning.json`
  (default 45, passive decay 0, per-lever deltas: damageHit, killMob,
  allyKillsRival, favorQuest, tribute, betrayal, event tunes).
- **ECS component:** `FamilyMembership` tag + `familyMembership` store
  (`familyId: Uint8Array`, `isBoss: Uint8Array`) added to
  `src/core/components.ts` and wired via `wireStore` in
  `src/core/world.ts` so it participates in serialization/reset.
- **World state:** `GameWorld` gains `factionRelations: Map<FamilyId, number>`,
  `factionRelationEvents`, `factionRelationDeltas`, and `floor2State`. All
  scoped by `createGameWorld()` / `resetFloorState()`.
- **Helpers (`src/core/faction-relations.ts`):** branded `FamilyId` /
  `ResourceId`; `bandFor` (inclusive FR8 bands 0–24 / 25–49 / 50–75 / 76–100);
  `clampRelation`; `getRelation`; `adjustFactionRelation` (clamps + emits
  `{familyId, before, after, band}`); `queueFactionRelationDelta`;
  `effectiveSpeedForHate` (FR9 pure ramp returning an absolute effective speed
  bracketed by `[base, player]`, no-op at `r >= 25` or `base >= player`);
  `initializeFactionRelations`;
  `selectFloor2Roster` (deterministic — rng-only Fisher-Yates on a copy,
  60% 3 / 40% 4 present families, one contested resource).
- **System:** `src/core/systems/familyRelationshipSystem.ts` drains
  `world.factionRelationDeltas` each tick; passive-decay branch guarded (off
  by default because `passiveDecayPerSecond: 0`).
- **Real-pipeline wiring (rule #15):** system registered in
  `src/bootstrap/floor-main-scene-options.ts` (`preSystems`, right after
  `manaSystem`, far from the locked `spawnerSystem`/`floor1EnemyDirectorSystem`
  adjacency) AND `src/game/ai/simulation-step.ts` (called after
  `manaSystem(world)` in the pre-movement section).
  `npm run check:wired-systems` → 42 systems, all wired.
- **Lab:** `src/labs/family-territory-lab/index.ts` — seeded roster snapshot,
  band-colored per-family bars, delta buttons (+5, -10, -50, betray-latch,
  reset). Registered in `src/lab-main.ts`. Note: per rule #10 the lab is a
  debug affordance — the wiring proof lives in the integration test.
- **Tests (40 new, all passing):**
  - `tests/unit/family-relationship.test.ts` — band boundaries 24/25, 49/50,
    75/76; clamp at 0/100; event emission; `effectiveSpeedForHate` corners
    (`r=0`, `r=25`, `base>=player`); monotonicity. (System drain + passive-decay
    coverage lives in `tests/ecs/familyRelationshipSystem.test.ts`.)
  - `tests/unit/floor2-selection.test.ts` — determinism (same seed → same
    selection); presentCount ∈ {3, 4}; disjoint families; resource in pool.
  - `tests/unit/family-data-schemas.test.ts` — Zod-validate both JSON files;
    id uniqueness; ≥15 families; hex color format.
  - `tests/unit/family-relationship.property.test.ts` — fast-check invariants:
    `bandFor` monotonic in `r`; relation stays in `[0, 100]` after any delta
    sequence; speed-ramp bracketed by `[base, player]`.
  - `tests/integration/family-relationship-wiring.test.ts` — runtime proof
    that BOTH real pipelines (headless `src/game/ai/simulation-step.ts` +
    visual `src/engine/sim/simulation-step.ts` via
    `createFloor1MainSceneOptions`) drain the delta queue.
- **Docs:** ADR 0040 gets a small changelog entry recording Slice 1 landing
  (no new ADR — the architecture is unchanged from the accepted decision).

## Runtime / real-artifact observation

Rule #10 satisfied via
`tests/integration/family-relationship-wiring.test.ts`, which is the real
artifact (it drives the actual headless `runSimulationStep` from
`src/game/ai/simulation-step.ts` and the visual `runSimulationStep` from
`src/engine/sim/simulation-step.ts` on options built by the real
`createFloor1MainSceneOptions`). Before: a queued delta on `world` sits
untouched in `world.factionRelationDeltas` after a tick. After: the same
delta is applied to `world.factionRelations` and the queue drains to zero —
proving the system is invoked by the real pipelines, not just the lab. The
lab is a designer affordance; it can never prove the real game calls the
system (spawnerSystem inert-ship failure, ADR 0039).

## What's Next

Slice 2 (`CaveSystemGenerator`) is being landed in parallel by a sibling
session. Slice 3 (AI band-driven targeting + ally follow + hate-ramp _applied_
at runtime via `effectiveSpeedForHate` — helper already lives here) is the
next dependency for this slice. Slices 4–8 follow the spec.

## Blockers

None at handoff. See "Mistakes Made" for the branch-drift near-miss.

## Branch State

- Branch: `floor2-slice1-relationships`
- All tests passing: yes (unit 40/40 new + full suite green,
  integration wiring test green, typecheck clean, lint clean,
  check:wired-systems green)
- PR created: yes (see final PR link below once opened)

## Agent-OS Telemetry

Guard telemetry captured via: none — no `files/guard-telemetry.jsonl` in this
session state.

## Test Results

- `npx vitest run --project unit tests/unit/family-*.test.ts
tests/unit/floor2-selection.test.ts` → 4 files, 40 tests, all pass.
- `npx vitest run tests/integration/family-relationship-wiring.test.ts`
  → 1 file, 2 tests, all pass.
- `npm run check:wired-systems` → 42 systems, all wired.

## Key Decisions Made

- **Wire the drain system in BOTH pipelines unconditionally.** The drain is a
  near-noop when the queue is empty, so gating it on floor id would add code
  paths without value and would risk Slice 3+ forgetting to enable it.
- **`effectiveSpeedForHate` lives here even though Slice 3 owns its runtime
  wiring.** Landing the pure helper now keeps Slice 3 from having to touch
  `faction-relations.ts` (avoids a rebase cost for the sibling session).
- **Deterministic Fisher-Yates on a copy in `selectFloor2Roster`.** Mutating
  the caller's roster array would have been faster but would have violated
  the "data files are immutable input" convention.
- **`FamilyId` / `ResourceId` are branded strings, not enums.** Enums would
  require a code-gen step keyed off the JSON, which is more machinery than
  Slice 1 needs.
- **No new ADR.** ADR 0040 already covers the design; a changelog entry on
  that ADR records Slice 1's landing.

## Retrospective

### Lessons Learned

- The `wireStore` convention (store key camelCase, tag PascalCase) is
  enforced by `defineComponent` naming, not by types alone — following the
  existing sibling components (`InventoryHolder` etc.) was the fastest way
  to get this right.
- `npm run check:wired-systems` uses AST parsing that only counts references
  from the five real-pipeline files. Lab or test references DO NOT count.
  This makes rule #15 self-checking: if the guard says "orphaned," it really
  means the system isn't in a real pipeline.

### Mistakes Made

- **Branch drift with a parallel session.** A sibling cloud session working
  on Slice 2 shared the local `/tmp/Crawler` checkout and ran
  `git checkout` / `git stash` on my working tree twice during the session,
  once as I was mid-write and once as I was mid-verify. Early signal: an
  integration test failing with `TypeError: asFamilyId is not a function`
  while the same import worked in unit tests — the actual root cause was
  that the parallel session had `git stash`d my Slice 1 files off the tree.
  Fix: commit early and push the branch immediately so working-tree loss can't
  happen. The sibling session was polite (labelled its stash
  `slice1-wip-stash-by-slice2-session`), which made recovery a one-liner —
  but the design lesson is "don't rely on the working tree to hold WIP when
  another session is running."

### Opportunities for Future Improvement

- Consider a per-session lockfile (or per-branch worktree) so parallel cloud
  sessions can't race on `git checkout` in a shared local checkout.
- The `family-territory-lab` renders bars with inline `style` strings; a
  small shared "band-colored bar" component in `src/labs/shared/` would let
  Slice 7's HUD widget reuse the color mapping instead of duplicating it.
- `selectFloor2Roster`'s presentCount probability (60/40 for 3/4) is a
  literal in code; migrating it into `tuning.json` alongside the relation
  deltas would let Slice 8's Governor sweep tune it without a code change.
