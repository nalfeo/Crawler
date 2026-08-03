# Handoff: Floor 2 — second den-unlock method (FR13 `win-favor`)

**Date:** 2026-08-03
**Complexity:** 🍎🍎🍎 (review ledger required — see `docs/knowledge/review-ledgers/2026-08-03-floor2-den-favor-unlock.review-ledger.json`)
**Spec:** `.specify/specs/floor2-family-territories.md` FR13 (revised — see below)
**ADR:** 0040 D4 (reuse existing plumbing) — no new ADR needed

## Systems touched

floor2-family-systems, quests

## Problem

Floor 2 ships six den-unlock archetypes in `quests.floor2.dens.json`, but only
the `killTargets` archetype (`thin-the-ranks`) was ever implemented —
`buildDenUnlockQuestPack` throws on every other kind and
`selectDenUnlockObjectives` filters the pool down to `killTargets`. Every den on
every seed opens the same way: kill 50 of the family's trash.

## What was done

Added the **second** route into a boss den: the peaceful `win-favor` path.

- `denFavorGoalId(familyId)` → `floor2-family-<id>-favor-earned`, seeded `false`
  at floor init next to the existing unlock/defeat/active flags.
- `hasEarnedDenFavor(world, familyId)` — pure read: true when the family's
  relation is in the Friendly band (>75, `bandFor`) and the reputation system is
  not explicitly inactive (`reputationSystemActive === false`).
- `floor2ObjectiveTick` latches `floor2-family-<id>-favor-earned` **and**
  `floor2-den-<id>-unlocked` the first frame the predicate holds. The existing
  ADR-0010 door-lock config opens the den doors from the same flag.

### Why this route is universal (FR13 contract revision)

The original FR13 spec listed `win-favor>75` as one seeded objective in the
pool. This revision makes it a **universal parallel bypass** instead, for one
concrete reason: `win-favor>75` is AI-unreachable (the headless AI fights,
which lowers relation via `killMob: -5`). Seeding it per-family would assign
AI-unreachable objectives to those families, stalling their dens in every
headless/seed run and collapsing the Floor 2 win-rate gate (rule #12). The
spec now carries two separate unlock paths: a seeded pool of AI-reachable
archetypes (thin-the-ranks / steal-ledger / sabotage-still / bring-tribute /
rival's-hit), plus the universal win-favor bypass that is always available to
the human player but never blocks the AI path.

## Files

- `src/game/floor2Scenario.ts` — favor goal id, predicate, init seeding, tick latch.
- `src/labs/family-boss-den-lab/index.ts` — "Win favor of first family (peaceful
  unlock)" action + per-family favor-route row in the panel.
- `tests/integration/floor2-den-favor-unlock.test.ts` — new (5 direct-tick + 1 pipeline).
- `.specify/specs/floor2-family-territories.md` — FR13 revised to document two routes.
- `scripts/agent/health/test-only-exports-lib.ts` — allowlist entries for `denFavorGoalId` / `hasEarnedDenFavor`.

## Observe before done

Validated through two observation paths:

**Direct-tick path** (5 tests): `initializeFloor2Bosses` → `floor2ObjectiveTick` →
`doorSystem` — confirms before/after door state for the favored family.

**Real simulation pipeline** (1 test): `runSimulationStep` with
`floorObjectiveSystem` in `postSystems` — dispatches
`world.floorObjectiveTick?.(world)` the same way both shipped simulation-step
pipelines do (`src/game/ai/simulation-step.ts` / `src/engine/sim/simulation-step.ts`).
This confirms the favor latch flows through the actual
`floorObjectiveSystem → world.floorObjectiveTick` dispatch, not just the
direct-call shortcut.

- **Before:** den locked, `floor2-den-<id>-unlocked = false`, both den doors
  `isLocked = 1` / `logicalOpen = 0`.
- **After** raising the family to Friendly and ticking: `favor-earned = true`,
  den unlocked, every den door `isLocked = 0` / `logicalOpen = 1`; sibling
  families remain sealed.

Covered cases: opens doors (direct-tick + pipeline), only the favored family opens, latch survives a
relation drop, inactive reputation system keeps it sealed, band boundary
(relation 75 = neutral → locked; 76 → unlocked).

## Verify

```bash
npx vitest run --project integration tests/integration/floor2-den-favor-unlock.test.ts  # 6 passed (5 direct-tick + 1 pipeline)
npx vitest run --project integration tests/integration/floor2-den-unlock-pipeline.test.ts  # 5 passed
npx vitest run --project unit tests/unit/floor2-den-unlock-selection.test.ts tests/unit/floor2-boss-spawn.test.ts tests/unit/floor2-scenario-initialization.test.ts  # 32 passed
npm run typecheck && bash scripts/agent/verify-fast.sh  # clean
```

## Follow-ups (remaining unlock methods)

1. **`steal-ledger` / `bring-tribute` (`collect`)** — needs per-family quest item
   ids in `src/shared/items.ts` plus a territory spawn point; the Floor 1
   shopkeeper fetch item (`spawnDroppedItem` in `floorScenario.ts`) is the
   pattern to copy.
2. **`sabotage-still` / `rivals-hit` (`goalFlag`)** — the goal-flag names are
   already owned by Slice 4; what is missing is the prop/NPC interaction that
   flips them.
3. Once a non-kill route is AI-reachable, widen the `killTargets`-only filter in
   `selectDenUnlockObjectives` — and re-run the Floor 2 headless gates first,
   because assigning an AI-unreachable objective would stall a den.
