# Session Handoff: Floor 3 safe-room doorway companion fix

## Date

2026-09-02

## Persona

Producer

## Systems touched

ai-pathfinding, ai-behavior-tree

## Apples

2🍎 exact

## What Was Done

Fixed the safe-room door seal so it does not close while a player-owned companion is still adjacent to the doorway. The door-system logic now treats both the player and any companion as transition actors when deciding whether a safe-room door may be forced shut, and the nearby door auto-open pass now opens closed doors for companion positions as well as player positions. Observed in the deterministic ECS reproduction: before, a companion standing adjacent to the safe-room door could still trigger a forced close; after the fix, the same path keeps the door passable and the `doorSystem` regression test passes.

## Key Decisions Made

- Keep the safe-room seal behavior player-safe by preserving the decoupled latch/effectiveOpen model while broadening the doorway occupancy check.
- Treat any allied companion in the doorway transition band as a valid actor for door passability so the door cannot seal on a companion half in/out of the room.
- Keep the fix narrow to the door authority and regression tests rather than adding a special-case companion rule elsewhere in AI logic.

## What's Next / Blockers

No blockers; the targeted regression is covered in `tests/ecs/door-system-safe-room.test.ts` and the companion AI suite remains green. A larger Floor 3 end-to-end repro can be added later if a broader production seed-only issue appears.

## Retrospective

### Lessons Learned

The regression was not in companion pathfinding itself but in the shared safe-room authority: a door that was valid for the player could still be sealed while a companion remained in the transition band. The safest fix is to widen the occupancy predicate rather than adding a companion-specific exception in the AI navigator.

### Mistakes Made

Initially I widened the fix only around the player path and missed the fact that the closure decision needs to consider all relevant actors together, not one actor at a time. That was corrected by centralizing the safe-room decision around the full set of nearby actors.

### Opportunities for Future Improvement

If another floor introduces different safe-room doorway semantics, the same helper pattern could be extracted into a small per-floor door-transition policy to make future regressions easier to audit.
