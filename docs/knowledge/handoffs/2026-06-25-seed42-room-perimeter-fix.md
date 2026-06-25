# Session Handoff: Seed 42 Room Perimeter Fix

## Date

2026-06-25

## Persona(s) adopted

Producer

## Routing verdict

✅ Right persona (cross-cutting gameplay map behavior + regression tests)

## Apples

Estimated: 🍎🍎  
Actual: 🍎🍎  
Verdict: 🎯 Exact

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

- Added `sealRoomPerimeterOpenings(...)` in `src/game/floor1Scenario.ts`.
- During Floor 1 initialization, applied perimeter sealing to:
  - primary safe room (`safeRoomPos`)
  - slime-rat objective room (`slimeRatRoomPos`)
- Sealing only converts passable non-door perimeter tiles to walls.
- Added a connectivity safeguard: sealing is skipped if it would make the target room unreachable from spawn through any room door.
- Hardened the safeguard to a **global** spawn-reachability check (review follow-up): a seal is now applied only when every tile reachable from spawn _before_ sealing — other than the sealed tiles themselves — stays reachable _after_. This prevents sealing a breach that is the sole route to some unrelated side region, so the function is safe to run on all seeds (not just seed 42). `sealRoomPerimeterOpenings` is now exported for unit testing.
- Added regression coverage:
  - `tests/game/floor1-scenario.test.ts` — seed 42 asserts the slime-rat room and primary safe room have no non-door perimeter openings.
  - `tests/game/seal-room-perimeter-openings.test.ts` — synthetic-map unit tests proving the guard seals a harmless breach but leaves a breach open when sealing it would isolate a side region.

## Validation

- `npm test -- tests/game/floor1-scenario.test.ts` ✅
- `npm run verify:fast` ✅
- `npm exec vitest run --project headless --reporter=dot` ✅
- `npm run verify` ✅

## Blockers

None.

## Notes

- `files/guard-telemetry.jsonl` not present in this session.
