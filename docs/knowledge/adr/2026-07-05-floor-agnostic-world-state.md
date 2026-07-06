# ADR 0047: Floor-Agnostic World State

**Date:** 2026-07-05  
**Status:** Accepted

## Context

Three patterns of floor-name baking were identified in the codebase:

1. `world.floor1: FloorScenarioState | null` — a field named after a specific floor
2. `world.floor === 1 ? LOOT_TABLES.FLOOR_1 : undefined` — hardcoded loot-table selection in `dropSystem`
3. `world.floor2State: Floor2State | null` and `world.floor2Settlement: Floor2SettlementSnapshot | null` — two separate top-level fields for floor-2-specific family/settlement mechanics

These patterns made it impossible to add a new floor without touching core world types and game systems. The field names made it appear that floor-specific mechanics required floor-specific code paths.

## Decision

### 1. Rename `world.floor1` → `world.floorScenario`

The field already held a `FloorScenarioState` value (a floor-agnostic type). Renaming to `floorScenario` removes the floor-number coupling.

### 2. Config-driven loot table selection

- Add `floorLootTableId?: string` to `FloorManifestDef` (floor manifest Zod schema)
- Add `"floorLootTableId": "floor_1"` to `floor1.manifest.json`
- Add `floorId: string` to `GameWorld`, set by each floor's scenario initializer
- Replace `world.floor === 1 ? LOOT_TABLES.FLOOR_1 : undefined` in `dropSystem` with:
  ```ts
  world.floorId ? getLootTable(getFloorManifest(world.floorId)?.floorLootTableId ?? '') : undefined;
  ```

### 3. Unify floor-2 extended state into `world.floorExtendedState`

Introduce a new `FloorExtendedState` interface in `world.ts`:

```ts
export interface FloorExtendedState {
  familyState?: Floor2State;
  settlement?: Floor2SettlementSnapshot;
}
```

Replace `world.floor2State` and `world.floor2Settlement` with `world.floorExtendedState: FloorExtendedState | null`. Consumers access `world.floorExtendedState?.familyState` and `world.floorExtendedState?.settlement`.

### 4. Remove `enableFloor1` SimulationOption

The option controlled whether floor-scenario systems ran. Since `world.floorScenario` is now null on non-scenario floors, the system checks `world.floorScenario` directly — no external flag needed.

## Systems touched

`core`, `engine`, `game`

## Consequences

### Positive

- A new floor can set `world.floorScenario`, `world.floorExtendedState`, and `world.floorId` without any changes to core types or `dropSystem`
- Loot table assignment is driven entirely by the floor manifest JSON
- `SimulationOptions` is simpler (no `enableFloor1` flag)
- `FactionRelationsWorldFacet` no longer names a floor

### Negative / Risks

- Large mechanical rename (~200 references across 40+ files); future merge conflicts on long-lived branches may be noisy
- `floorExtendedState?.familyState` is one level deeper than `floor2State`; test assertions are more verbose

### Alternatives Considered

- **Keep `world.floor2State` but add a generic accessor** — rejected: still leaves a floor-named field as the source of truth
- **Use a `Map<string, unknown>` keyed by floorId** — rejected: loses type safety; `FloorExtendedState` is intentionally typed
- **One field per mechanic type (e.g. `world.familyState`)** — considered; chosen approach is equivalent but groups all floor-specific extensions under one nullable container making null-check semantics clear
