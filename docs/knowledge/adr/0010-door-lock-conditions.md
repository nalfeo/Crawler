# ADR 0010: Flexible Door Lock Conditions with Optional Relock

**Date:** 2026-06-09  
**Status:** Accepted  
**Deciders:** Systems Engineer

## Context

Doors previously used a single open/closed state and nearby-player auto-open behavior.  
Floor/tutorial flows and future dungeon logic need deterministic lock behavior driven by game state, not hardcoded proximity alone.

The new lock model must:

1. Support multiple unlock conditions per door.
2. Support `ALL` / `ANY` operators for condition groups.
3. Allow optional secondary relock conditions when gameplay needs doors to close again.
4. Remain deterministic (`world.elapsedMs`, ECS/world state only).
5. Preserve existing unlocked door behavior and tile/FOV semantics.

This touches multiple layers:

- `src/core` (lock model, world state, ECS/system transitions)
- `src/game` (goal-state integration for scenario conditions)
- `src/labs` (new lock lab coverage)

## Decision

We introduce a door lock configuration model with two condition groups:

1. **Primary unlock group** (required): `operator` + condition list
2. **Secondary relock group** (optional): `operator` + condition list

Condition types implemented now:

- **Inventory key present** (`itemId`, `quantity`, optional holder)
- **Goal flag complete** (`goalId`)
- **Timer elapsed** (`elapsedMs` threshold against `world.elapsedMs`)

Runtime behavior:

- Doors keep explicit `isLocked` and `wasUnlocked` runtime fields.
- Lock evaluation runs inside `doorSystem` before auto-open proximity logic.
- Locked doors are always forced closed (`isOpen = 0`).
- Auto-open proximity behavior applies only to doors that are currently unlocked.
- Unlock/relock transitions are idempotent and frame-safe.
- If unlock and relock evaluate true in the same frame, **relock takes precedence** to avoid oscillation.

## Consequences

### Positive

- Data-driven lock logic reusable across scenarios and maps.
- Deterministic progression gates based on inventory/goals/timers.
- Optional relock enables trap/timed/security-style encounters.
- Existing unlocked-door traversal behavior is preserved.
- Labs/tests now cover lock and relock combinations directly.

### Negative

- More door runtime/config state to manage (`doorLockConfigs`, `goalFlags`, extra door fields).
- Slightly higher per-frame door evaluation cost.
- Designers must define goal flags/condition sets correctly for each scenario.

### Risks

- Misconfigured condition groups (empty/invalid values) could create unintuitive locks.
- Overlapping unlock/relock thresholds can create rapid toggling intent; system resolves this via relock precedence.
- Goal-flag naming inconsistency across scenarios could reduce reusability without shared conventions.

## Alternatives Considered

1. **Single condition per door only**: rejected; insufficient for tutorial and future composite gates.
2. **Unlock-only model with no relock support**: rejected; does not satisfy optional secondary relock requirement.
3. **Separate lock/relock systems outside `doorSystem`**: rejected for now; integrated evaluation keeps tile sync and behavior ordering explicit and simple.
4. **Use wall-clock timers (`Date.now`)**: rejected; violates deterministic ECS requirements.

## References

- Core lock model: `src/core/door-lock.ts`
- Door runtime/system updates: `src/core/components.ts`, `src/core/systems/doorSystem.ts`, `src/core/world.ts`
- Scenario goal integration: `src/game/floor1Scenario.ts`
- Lab: `src/labs/door-lock-lab/index.ts`
- Tests: `tests/ecs/door-lock-system.test.ts`, `tests/ecs/door-system.test.ts`
