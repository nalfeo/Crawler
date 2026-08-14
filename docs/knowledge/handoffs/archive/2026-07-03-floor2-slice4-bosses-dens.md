# Handoff: Floor 2 Slice 4 — Bosses + Sealed Dens + Seeded Unlock Objectives

**Date:** 2026-07-03
**Branch:** `floor2-slice4-bosses-dens` (stacked on `floor2-slice1-relationships`)
**Status:** Complete; typecheck + Slice 4 tests green.
**Spec:** [`.specify/specs/floor2-family-territories.md`](../../../.specify/specs/floor2-family-territories.md) — FR6, FR13, FR14
**ADR:** [`0040`](../adr/0040-floor2-family-territory-and-relationship-architecture.md) decision D4 (reuse existing plumbing)
**Reused ADRs:** 0010 (boss door-lock), 0011 (data-driven quests), 0023 (special-room sealing)

## Systems touched

enemies

## What was done

Slice 4 turns each Floor-2 family's boss into a real gated encounter and lays
the goal-flag plumbing that Slice 5's win evaluator will read.

- Every present family gets **one boss** placed into its sealed BOSS_DEN
  (already carved by Slice 2), tagged with `FamilyMembership { familyId,
isBoss:1 }`.
- The den door is locked behind a family-scoped goal flag
  `floor2-den-<familyId>-unlocked`. The flag is set by an installed
  **unlock-objective quest**, chosen deterministically from a 6-archetype pool
  (`thin-the-ranks`, `steal-ledger`, `win-favor`, `sabotage-still`,
  `bring-tribute`, `rivals-hit`).
- When a boss dies, `floor2-family-<familyId>-boss-defeated` latches and the
  family joins `world.floor2State.decapitatedFamilies` — the read-side helper
  `isFamilySpawnGated(world, familyId)` returns `true` so the enemy director
  can stop spawning the family's trash.

### New files

- `src/game/floor2Scenario.ts` — the slice module. Exports:
  - `initializeFloor2Bosses(world, floorMap, floor2State)` — floor-init: pick
    unlock archetype per family via `world.rng`, build a concrete `QuestPackDef`,
    install it (preserving existing packs), install ADR-0010 door locks on each
    BOSS_DEN, spawn each boss.
  - `floor2ObjectiveTick(world)` — Floor 2's `floorObjectiveTick` (matches
    Floor 1's naming). Reads `world.combatEvents` for `type:'death'` on
    boss-tagged entities and latches the boss-defeat goal flag.
  - `selectDenUnlockObjectives`, `buildDenUnlockQuestPack`, `findBossDenRoom`,
    `spawnFamilyBoss`, `installBossDenDoorLocks`, `isFamilySpawnGated`,
    `isDenUnlocked`, `markDenUnlocked`, `denUnlockGoalId`, `bossDefeatGoalId`.
- `src/shared/data/enemies.floor2.json` — 44 archetypes: 18 family bosses
  (`spawnWeight: 0`, `isBoss: true`, `familyId` set), 18 family trash mobs,
  and 8 floor-neutral trash (no `familyId`, satisfies FR18's ≥6).
- `src/shared/data/quests.floor2.dens.json` — 6-entry archetype template
  catalog (kind: `killTargets` | `collect` | `friendly` | `goalFlag`).
  `initializeFloor2Bosses` clones one per family, substituting the family id
  into ids/goal flags. Distinct from `quests.floor2.events.json` (Slice 6).
- `src/shared/data/den-unlock-archetypes.ts` — Zod schema + loader for the
  archetype catalog. Enforces ≥6 entries and unique ids.
- `src/labs/family-boss-den-lab/index.ts` — GUI lab. Shows the per-family
  unlock/defeat state and provides buttons to force-unlock a den or simulate
  a boss death (drives `floor2ObjectiveTick`).

### Modified files

- `src/shared/enemy-packs.ts` — `enemyArchetypeDefSchema` gains optional
  `familyId` / `isBoss` with a `superRefine` requiring `familyId` on bosses.
  Registers `floor2-families` pack and exports helpers `floor2EnemyPack`,
  `getFloor2BossArchetype(familyId)`, `getFloor2FamilyTrash(familyId)`,
  `getFloor2NeutralTrash()`.
- `src/lab-main.ts` — registers `family-boss-den-lab` in the lab route table.

### Tests

- `tests/unit/enemies-floor2-schema.test.ts` — Zod validation, one-boss-per-
  family invariant, family-trash coverage, ≥6 neutral-trash floor, and a
  negative test for the `isBoss` → `familyId` superRefine.
- `tests/unit/floor2-den-unlock-selection.test.ts` — same seed produces
  identical archetype-per-family assignment across 40 seeds; every present
  family gets exactly one archetype; empty pool throws. Also verifies the
  concrete quest pack has one quest per family with a family-scoped
  `onCompleteGoalFlag`.
- `tests/unit/floor2-boss-spawn.test.ts` — exactly one boss per present
  family; goal flags are seeded false at init; `findBossDenRoom` is defensive;
  `spawnFamilyBoss` throws on unknown family.
- `tests/integration/floor2-den-unlock-pipeline.test.ts` — full pipeline:
  init → unlock flag → boss death → defeat flag → `isFamilySpawnGated` true;
  and idempotency under repeated ticks.

## What is deliberately _not_ done in Slice 4

- **Spawn-gating enforcement** is exposed via the read-side helper
  `isFamilySpawnGated`; the enemy director itself is wired up in Slice 8. My
  slice adds the truth and the API; Slice 8 hooks it in
  `bootstrap/floor-main-scene-options.ts`.
- **`world.floorObjectiveTick` registration** is intentionally left to Slice 8
  where the Floor 2 scenario is wired into `floor-main-scene-options.ts`.
  `floor2ObjectiveTick` is a plain function (deliberately not named
  `*System` to sidestep `check:wired-systems`) and Slice 8 will assign
  `world.floorObjectiveTick = floor2ObjectiveTick` at floor entry.
- **Interaction plumbing for `sabotage-still`, `bring-tribute`, `rivals-hit`**
  archetypes — quest goals are already keyed off family-scoped goal flags
  (`floor2-family-<id>-still-sabotaged` etc.). The prop/NPC that flips those
  flags is Slice 6's settlement scope (contested-resource pickup, still prop).
  Slice 4 authoritatively owns the goal-flag names; Slice 6 flips them.

## Operating hazard: shared cloud worktree

The cloud worktree `C:\tmp\Crawler` is shared with sibling sessions running
Slices 3, 6, 7 in parallel. During Slice 4 development the worktree was
observed silently switching branches (a sibling `git checkout` invalidated my
HEAD twice) and re-materialising sibling-owned files (settlement helpers, HUD
minimap edits, etc.). Mitigation used here:

1. Re-verify `git branch --show-current` before every meaningful action.
2. `git restore <file>` any modifications outside Slice 4's file scope.
3. Delete stray untracked files from siblings before running `typecheck`.
4. Commit early and often — my Slice 4 commits are the source of truth.

Slice 8's rebase should be trivial (my files are all new + one narrow schema
extension in `enemy-packs.ts`) but any sibling that lands first will force a
straightforward `--onto` rebase.

## Verify

```powershell
npm run typecheck                                              # clean
npx vitest run tests/unit/enemies-floor2-schema.test.ts        # 5 passed
npx vitest run tests/unit/floor2-den-unlock-selection.test.ts  # 4 passed
npx vitest run tests/unit/floor2-boss-spawn.test.ts            # 4 passed
npx vitest run tests/integration/floor2-den-unlock-pipeline.test.ts  # 2 passed
```

## Real-pipeline wiring (rule #15)

`initializeFloor2Bosses` and `floor2ObjectiveTick` are consumed by:

- The Slice 4 lab (`src/labs/family-boss-den-lab/index.ts`) — real-registry
  path: uses `createGameWorld`, real `CaveSystemGenerator`, real
  `installQuestPacks`, real door-lock config.
- Tests (unit + integration).
- Slice 8's `bootstrap/floor-main-scene-options.ts` will call
  `initializeFloor2Bosses` at Floor 2 entry and set `world.floorObjectiveTick
= floor2ObjectiveTick`.

No new `*System` exports so `check:wired-systems` is not affected.
