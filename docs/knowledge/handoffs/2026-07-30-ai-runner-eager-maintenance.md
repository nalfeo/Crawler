# AI Runner Eager Maintenance Tick

**Date:** 2026-07-30  
**PR:** Closes #2370  
**Apple estimate:** 🍎🍎🍎  
**Verdict:** Recommended — straightforward gap-fill in the AI maintenance pipeline

## Systems touched

`game/ai`, `game/equipment`, `game/ai/headless-runner`

## Problem

The headless/AI runner acquired achievement reward boxes and generated-equipment bag
items but never claimed or equipped them. Boxes sat unclaimed; equipment sat unequipped
even when matching slots were empty.

**Root cause:** The only claim+equip path was `runSettlementMaintenancePlanner`, which
is gated to physical Floor 2 settlement-room presence (one-per-visit latch). Achievements
unlocking anywhere else (Floor 1, Floor 2 combat areas, or while already inside the
settlement after the latch fired) were silently ignored for the rest of the run.

## Solution

Added `runEagerMaintenanceTick(world, playerEid)` to
`src/game/ai/settlement-maintenance-planner.ts`, called **unconditionally every AI tick**
before `runSettlementMaintenancePlanner` in both the headless runner and the AI lab:

1. **Claims all unlocked-but-unclaimed achievement rewards** — any floor, any location.
2. **Equips generated-equipment bag candidates** via `runBagOnlyEquipmentLoop` — a
   thin wrapper over the shared `runEquipmentLoop` that:
   - Filters to `source === 'inventory'` only (Quartermaster shop purchases remain
     settlement-gated).
   - Uses `{ force: true }` on `equipFromBag` to bypass the safe-room context gate
     (matching the pattern already used in `auto-progression.ts` and
     `merchant-weapon-intent.ts`).
   - Gates on `floor2EquipmentAiMaintenance`; is a cheap no-op on Floor 1.
3. **Retries deferred claims** after equipping frees bag slots.
4. **Fills remaining open ability slots** with already-owned abilities.

Boss chest opening is intentionally left to `runSettlementMaintenancePlanner` to preserve
the chest lifecycle (available → opening → revealed → claimed) and UX review flow.

The settlement planner still handles Quartermaster shop purchases (location-gated by
design) during settlement visits.

## Key design decisions

- **`force: true` for bag equips** — The `isInSafeContext` guard on `equipFromBag`
  protects the player-facing UI from surprise equip changes outside safe rooms. In the
  headless AI runner there is no player UI, so `force: true` is appropriate (same
  rationale as `auto-progression.ts`).
- **Inventory-only filter** — Shop candidates require gold + physical Quartermaster
  presence. Excluding them keeps the eager path safe to call from any tick.
- **Boss chests stay settlement-gated** — Boss chests are opened by
  `runSettlementMaintenancePlanner` during settlement visits. Moving them to the eager
  tick would break the `available → opening → revealed → claimed` lifecycle contract
  and the associated UX review flow; it is not necessary for the core goal of
  claiming achievement rewards and equipping bag items.
- **`runBagOnlyEquipmentLoop` is a thin wrapper** — Rather than a parallel
  implementation, it passes `{ inventoryOnly: true, force: true, bagEmptyShortCircuit: true }`
  to the shared `runEquipmentLoop`, which already handles candidate evaluation, ranking,
  blacklisting, equip telemetry, and ability application.
- **Idempotent** — Already-claimed achievements exit immediately; already-equipped items
  won't match as improvements; the latch in `runSettlementMaintenancePlanner` is
  unaffected.

## Files changed

| File | Change |
|---|---|
| `src/game/ai/settlement-maintenance-planner.ts` | Added `runEagerMaintenanceTick` (exported); added `EquipmentLoopRunOptions` to parameterise `runEquipmentLoop`; `runBagOnlyEquipmentLoop` is now a thin wrapper over the shared loop |
| `src/game/ai/headless-runner.ts` | Import + call `runEagerMaintenanceTick` every tick; removed dead `classifyGameOverOutcome` export |
| `src/labs/ai-runner-lab/index.ts` | Import + call `runEagerMaintenanceTick` every tick |
| `tests/game/settlement-maintenance-planner.test.ts` | 9 new tests for `runEagerMaintenanceTick` |

## Tests

9 new unit tests in `tests/game/settlement-maintenance-planner.test.ts`:
- Floor 1 lootBox claiming without settlement room
- Multi-achievement claiming in one tick
- Idempotency (double-call no-ops)
- Floor 2 equipment-type achievement claiming outside settlement
- Equipping from bag outside settlement + safe-room (`playerInSafeRoom=false` proves `force:true`)
- Empty-slot-first priority
- Shop exclusion (no gold spent, no equip of shop-only items)
- Multi-slot equipping
- Deferred-retry: bag-full blocks claim → equip frees slot → retry succeeds

## Knip suppressions

The existing suppressions for `equipment-loadout-evaluator.ts` and
`settlement-maintenance-planner.ts` cover exported types that still have no external
callers (e.g., `SettlementMaintenanceDecisionKind`, evaluation result types). These
remain valid — cleanup deferred to a follow-on PR per their `expiresOn: 2026-09-30`.

## Acceptance criteria status

- [x] Runner opens reward boxes it holds
- [x] Runner fills empty slots before contested ones
- [x] Persona preference applied after empty-slot fill
- [x] Runner reads both inventory lanes (`bag.slots` + `bag.generatedEquipment`)
- [x] Win-rate unmoved — all 176 headless tests pass on this branch (27 test files, including
  `floor1-completion`, `floor1-legacy-death-regressions`, `floor1-staircase-boss-lockin-seed8`,
  and `boss-chest-lifecycle`). A full AI sweep can be dispatched post-merge via
  `ai-sweep.yml` for a broader leaderboard read, but the required 90%+ Floor 1 gate is
  covered by the headless suite above.
