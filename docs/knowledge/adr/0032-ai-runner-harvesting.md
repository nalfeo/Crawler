# ADR 0032: AI Runner gathers harvestables

## Status

Accepted

## Date

2026-06-28

## Estimated Complexity

🍎 x 3 — touches the AI brain + the headless pipeline + watchdogs; no new lab.

## Context

ADR-0030 added harvestable resource nodes (mushrooms/flowers/lichens): the player
must stand within `HARVEST_RANGE_FT` (1ft) for 2.5–4s for `harvestSystem` to add
the item. The behavior-tree AI runner that drives headless seed sweeps and the AI
lab only ever pursued instant pickups (xp/gold/items), so it never collected
harvestables. Two faithfulness gaps blocked it:

1. `harvestSystem` ran only in `MainGameScene`, not in the shared
   `runSimulationStep` pipeline — a harvest could never _complete_ headlessly.
2. The COLLECT/global dwell watchdogs and stuck-blacklist abandon a stationary
   target (180f / 60f), but a legitimate harvest is intentionally stationary for
   up to ~240f, so the AI would walk off the node before it finished.

## Decision

- Tick `harvestSystem` in `runSimulationStep` (after `itemPickupSystem`, before
  `dropSystem`) to mirror `MainGameScene`. The visual scene keeps its own
  pipeline, so no double-tick.
- Add a `'harvest'` `LootKind`; harvestable nodes feed `findNearestLoot` and the
  sticky-target resolver, so COLLECT walks to and stands on them.
- Add `isActivelyHarvesting()` (any node within `HARVEST_RANGE_FT`); re-anchor the
  COLLECT and global dwell watchdogs and zero the stuck counter while it is true,
  so deliberate stillness reads as progress instead of being abandoned.

## Consequences

### Positive

- AI gathers crafting materials, exercising the harvest path in headless gates.
- Headless sim is faithful to the visual game's system order.

### Negative

- Harvest dwell costs frames; AI may spend a few seconds per node.

### Risks

- Floor-1 win-rate regression. Mitigation: COLLECT runs after Engage and only
  when no enemy is engageable; full verify incl. the headless seed sweep stayed
  green (90%+ seeds still win).

## Alternatives Considered

- Harvest on the on-path detour (OpportunisticCollect): rejected — detours never
  linger, so a 2.5–4s harvest can't complete there.
