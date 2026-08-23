# ADR-0091: Floor 1 AI recovery state contracts

## Status

Accepted — the cleared-arena bullet below is amended by
[ADR-0092](0092-cleared-arena-safe-room-purge.md)

## Date

2026-08-22

## Estimated Complexity

🍎🍎🍎🍎 — coordinates Floor 1 scenario state, AI planning/execution, shared safe-room data, and regression coverage.

## Context

Headless Floor 1 seed 42 exposed several coupled progression failures:
optional purchases could spend the gold needed for the required shopkeeper
charm, the AI beelined objectives while leaving nearby farming value behind,
post-boss time was spent descending immediately instead of using the remaining
safe budget, boss chests spawned at authored room anchors instead of death
spots, and cleared boss arenas were not treated as safe retreat/equip spaces.

These behaviors cross the scenario layer, behavior-tree input provider, goal
planner, shared floor state, and core safe-space helpers. A single-system change
would either be ignored by another layer or reintroduce split-brain behavior
between headless planning and runtime execution.

## Decision

- Reserve the Floor 1 shopkeeper charm cost while that required purchase remains
  incomplete. Apply the same reserve to optional-purchase planning, spell-broker
  intent, and auto-progression execution so the planner does not emit detours
  the executor refuses to fund.
- Add explicit AI tuning knobs for calm en-route farming and post-boss farming.
  Calm farming is disabled while panic/beeline logic is active; post-boss
  farming yields once the configured reserve fraction of the floor budget
  remains.
- Treat boss reward chests as physical drops at the boss death position. Scenario
  state samples live boss positions before death cleanup can clear component
  stores, freezes the first death-timer position for delayed removal paths, and
  falls back to the authored room anchor only when the sampled point is outside
  the owning arena.
- Track cleared safe rooms by owning `FloorMap` rather than by bare room id so a
  cleared Floor 1 arena cannot make an unrelated room with the same id safe on a
  later floor.
- Preserve boss room roles instead of rewriting them to `SAFE`; safe-space
  helpers consult the cleared-room set when resolving retreat/equip anchors.
  (Amended by ADR-0092: cleared boss rooms remain true safe spaces, but any
  live enemies already inside are purged without loot/XP and the post-boss
  farm window is clamped against the authored floor budget.)

## Consequences

### Positive

- Required Floor 1 purchases can no longer be priced out by optional detours.
- The headless AI gains deterministic farming windows without weakening the
  promoted default sweep configuration.
- Reward chests appear where the boss died while remaining reachable.
- Cleared boss arenas become usable retreat/equip spaces without breaking
  boss-room identity, staircase lookup, minimap semantics, or spawn suppression.
- Cross-floor safe-room state is scoped to the floor that owns the room ids.

### Negative

- Floor 1 progression now has more explicit coordination points between the
  planner, behavior tree, and scenario systems.
- The world safe-room state carries a `FloorMap`-scoped companion map in
  addition to the legacy id set.

### Risks

- Future boss encounters with delayed death cleanup must preserve the
  sample-before-defeat pattern or they can regress to stale/corpse-slide chest
  placement.
- Future AI tuning changes should validate broad win-rate and resource-spend
  gates rather than tuning around one seed.

## Alternatives Considered

1. **Reserve gold only at the executor.** Rejected because the planner would
   still emit optional buy detours and the intent layer would keep returning to
   the merchant without a purchasable action.
2. **Rewrite cleared boss rooms to `SAFE`.** Rejected because role-derived
   getters use the boss role for staircase ownership, minimap behavior, and
   spawn suppression.
3. **Spawn boss chests at authored anchors only.** Rejected because it hides the
   physical boss drop and contradicts the new death-position reward contract.
4. **Store cleared safe rooms by room id only.** Rejected because generated room
   ids are unique only within one `FloorMap`, not across floors.
