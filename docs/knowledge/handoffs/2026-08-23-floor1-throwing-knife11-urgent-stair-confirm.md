# Session Handoff: Floor 1 throwing-knife seed 11 release timeout

## Date

2026-08-23

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding

## Apples

2🍎 estimated / 2🍎 actual

## What Was Done

- Reproduced the release-leg failure signature in the real headless pipeline options:
  `floor=floor1|forceWeapon=true|damage=1|seed=11|weapon=throwing-knife`.
- Confirmed deterministic timeout at the Floor 1 release frame cap (`FLOOR1_DEFAULT_MAX_FRAMES`): outcome `timeout` at ~660s with `floor1-leave-floor` incomplete.
- Implemented a surgical auto-progression fix in `src/game/ai/auto-progression.ts`:
  when Floor 1 collapse panic reaches beeline urgency, stair-confirm proximity expands from the normal marker radius (8ft) to a bounded urgent radius (24ft), then existing defer logic still applies.
- Added deterministic regression coverage:
  `tests/headless/floor1-throwing-knife11-release-regression.test.ts`.

## Observe before done (real artifact)

- **Before:** direct headless run (`runHeadless` sweep-equivalent settings, forced throwing-knife seed 11, Floor 1 release frame cap) timed out at 660s.
- **After:** same settings now produce deterministic victory within the same frame cap (paired reruns in regression test).

## Verification Run

- `npm run test:headless -- tests/headless/floor1-throwing-knife11-release-regression.test.ts`
- `npm test -- tests/headless/floor1-completion.test.ts`
- `bash scripts/agent/verify-fast.sh`

## Unresolved / Follow-ups

- This change is intentionally narrow to the reproduced Floor 1 timeout signature; no broad sweep was dispatched in-session.
