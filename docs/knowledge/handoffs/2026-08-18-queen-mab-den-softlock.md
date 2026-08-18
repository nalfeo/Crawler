# Session Handoff: Queen Mab Den Softlock

## Date

2026-08-18

## Persona

Game Designer

## Systems touched

boss-rooms, enemies, devtools

## Apples

3🍎 exact

## What Was Done

Fixed the Floor 2 seed-42 Queen Mab softlock: an unlocked boss could leave her den, then player entry relocked the door around an empty room. Encounter start now returns a valid boss to its recorded den spawn before relocking, and refuses to relock when the boss record is invalid. The unstick routine also restores a boss to its den spawn rather than nudging it outside the den.

Added JSONL boss encounter snapshots and discrete transitions to player-session and AI Runner recordings: boss tile/room/visibility/health/entity existence, den occupancy, active goal, and door lock state. Observed in the real headless pipeline: Floor 2 seed 42 ran 49,579 frames without a started, locked encounter whose boss was outside its den.

## Key Decisions Made

- Contain a strayed boss at encounter start instead of keeping the doors open: preserves the intended sealed-den fight while removing the softlock.
- Treat a missing boss eid, spawn position, Enemy component, or Health component as invalid and leave the den open; never relock around an absent boss.
- Keep full RunStats/interactive telemetry unification in issue #3093; this change only adds the diagnostics needed for the reported player-session failure.

## What's Next / Blockers

- Follow issue #3093 to make the equivalent boss telemetry contract consistent across headless RunStats, AI Runner, and player-driven sessions.
- No blocker for this fix.

## Retrospective

### Lessons Learned

Floor 2 `activeGoalId` is a door relock input, so encounter-start invariants must include boss location and liveness, not only player room entry. The supplied recorder log had no boss data; session logs need enough spatial and lock-state evidence to diagnose a sealed-room boss directly.

### Mistakes Made

The initial headless census proved that bosses did not duplicate, but it could not exercise the interactive timing where an unlocked boss walks out before player den entry. The first review also ran against stale local `main`, which included hundreds of unrelated already-merged commits; rebasing onto `origin/main` and reviewing against that ref restored the actual three-commit PR scope.

### Opportunities for Future Improvement

Unify `RunStats`, AI Runner, and player-session telemetry through the shared contract tracked in #3093, including a replayable fixture that compares equivalent Floor 2 boss lifecycle evidence across all collectors.
