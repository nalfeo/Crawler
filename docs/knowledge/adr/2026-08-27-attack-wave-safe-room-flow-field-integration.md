# ADR: Attack-wave safe-room suppression uses door-aware multi-source flow fields

## Status

Accepted

## Date

2026-08-27

## Estimated Complexity

🍎 x 3 — cross-layer change (`src/core` flow-field API usage + `src/game` runtime system integration) with deterministic tests and a focused lab.

## Context

Periodic rat attack waves on Floor 1 suppress spawning when the player is near a safe room by pathable distance, not Euclidean distance.
The first implementation cached a safe-room flow field built from raw tile passability, which treats closed door tiles as blocked.
That caused two correctness gaps:

- auto-openable closed doors could make a path exist at runtime while the cached field still reported unreachable;
- cache invalidation did not account for door-navigation topology changes, so stale suppression decisions could persist across lock-state transitions.

The same system also needed to keep wave-rat contact damage aligned with canonical rat templates.

## Decision

- **DEC-001**: Build safe-room suppression flow fields with door-aware traversability by passing `buildDoorAwarePassable(world)` into `computeMultiSourceFlowField(...)`.
- **DEC-002**: Extend cache invalidation with a deterministic door-navigation snapshot (`getDoorNavInfos(...)`) so suppression fields rebuild when door-blocker topology changes.
- **DEC-003**: Spawned wave rats now receive a `Damage` component initialized from `ratTemplate.contactDamage`, matching `spawnerSystem` behavior.
- **DEC-004**: Add `attack-wave-lab` in `src/labs/` so the runtime system has a focused lab entry point before shipping.

## Consequences

### Positive

- Safe-room suppression now respects closed-but-auto-openable doors and lock/unlock transitions.
- Spawned wave rats now deal the same contact damage as other canonical rats.
- The behavior remains deterministic and shared by real game wiring.

### Negative

- Safe-room suppression now computes a lightweight door snapshot each tick it evaluates suppression.

### Risks

- Future door-navigation semantic changes must keep `getDoorNavInfos` aligned with pathfinding passability assumptions to preserve cache correctness.
