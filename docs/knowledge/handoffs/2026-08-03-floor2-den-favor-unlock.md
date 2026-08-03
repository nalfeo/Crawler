# Handoff: Floor 2 — second den-unlock method (FR13 `win-favor`)

**Date:** 2026-08-03
**Complexity:** 🍎🍎 (no review ledger required)
**Spec:** `.specify/specs/floor2-family-territories.md` FR13
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

### Why this route, and why it is regression-safe

It is a **parallel** route, not a replacement: the assigned kill objective still
unlocks the den on its own, so the headless AI (which only fights, and whose
kills *lower* relation via `killMob: -5`) is behaviourally unchanged. That keeps
the Floor 2 win-rate/boss-level gates untouched while giving the player a real
alternative. Relation is already player-movable through the Slice 6 emergent
events (`favorQuestComplete +15`, `tributeDelivered +10`, `protectionPaid +5`,
`pickASideChosen +8`) from the default 45.

The unlock is **latched**: a later relation drop (e.g. the player turns on the
family after entering) can never re-seal a den they already earned entry to.

## Files

- `src/game/floor2Scenario.ts` — favor goal id, predicate, init seeding, tick latch.
- `src/labs/family-boss-den-lab/index.ts` — "Win favor of first family (peaceful
  unlock)" action + per-family favor-route row in the panel.
- `tests/integration/floor2-den-favor-unlock.test.ts` — new.

## Observe before done

Deterministic headless observation through the **real** pipeline (real
`initializeFloor2Bosses` → real `floor2ObjectiveTick` → real `doorSystem`), not
a lab-only check:

- **Before:** den locked, `floor2-den-<id>-unlocked = false`, both den doors
  `isLocked = 1` / `logicalOpen = 0`.
- **After** raising the family to Friendly and ticking: `favor-earned = true`,
  den unlocked, every den door `isLocked = 0` / `logicalOpen = 1`; sibling
  families remain sealed.

Covered cases: opens doors, only the favored family opens, latch survives a
relation drop, inactive reputation system keeps it sealed, band boundary
(relation 75 = neutral → locked; 76 → unlocked).

## Verify

```bash
npx vitest run --project integration tests/integration/floor2-den-favor-unlock.test.ts  # 5 passed
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
