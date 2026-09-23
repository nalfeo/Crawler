# Session Handoff: Floor 5 gameplay objectives

## Date

2026-09-20

## Persona

Producer coordinating game mechanics, UX contract, and QA.

## Systems touched

Floor 5 siege objectives, quest waypoints, shared scenario interaction,
MainGameScene interaction, combat death telemetry.

## What changed

- Removed the one-second automatic completion path.
- Opening push now requires a player-attributed hostile siege death; yard and
  checkpoint require the player at their authored site with local hostiles
  cleared; components and Ram authorization require proximity interaction.
- Existing quest goals now resolve to authored Floor 5 set-piece markers.
- HUD names component and construction prerequisites; the generic interact hint
  forwards only scenario-validated actions.

## Verification

- `npm run typecheck:src` passed.
- `npm test -- --project headless tests/headless/floor5-siege-foundation.test.ts`
  passed (16 tests), including idle-at-spawn and interaction/marker coverage.
- Existing Floor 5 real-scene Playwright probe completed with local Chromium
  launch permission.

## Follow-up

Run the full PR prerequisite gate and record the final review result before
publication. Lane cadence, Ram protection/rebuild, courtyard, and finale stay
out of scope.
