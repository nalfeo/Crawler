# Handoff: Floor 6 wave-status readability

## Systems touched

floor6-scenario, scenario-presentation, main-game-scene, floor6-tests

## Summary

Added one authoritative, non-color-only wave-status line to Floor 6's existing
scenario HUD. During defense it names the earliest queued immutable-manifest
wave and its incoming route. During service breaks, the Deadline finale, and
terminal states it instead supplies an explicit actionable status. Route labels
remain spatial world markers; the renderer continues to consume the scenario
projection without inspecting floor-specific wave state.

No wave timing, routing, economy, tower roles, automatic combat, human
movement/equipment/build controls, or deterministic simulation behavior changed.

## Observation

Before: the Floor 6 scene showed every route's spatial direction marker, but
the HUD did not identify the single next wave the player should prepare for.

After: the HUD reads `Next wave 1 (opening-crew): incoming from west route →
Relay.` at the normal defense start. It states distinct, readable service-break
and Deadline states rather than relying on color or a player inferring phase
meaning from map markers.

## Verification

- `npx vitest run --project unit tests/unit/floor6-wave-director.test.ts tests/unit/scenario-definitions.test.ts` — 75 passed.
- `npx vitest run --project headless tests/headless/floor6-economy-obs.test.ts` — 2 passed, including the terminal-safe real headless pipeline snapshot.
- `npm run typecheck:src` — passed.
- Real-scene E2E was launched against local Chromium with elevated desktop permission after the sandbox blocked Chromium (`EPERM`); the terminal bridge did not return its final summary after the capture window.
- `npm run verify:fast` was started; this terminal bridge did not return its terminal summary. Re-run before relying on its status if the process result is not otherwise recorded.

## Unresolved issues

The repository-wide fast-gate terminal status and real-scene E2E terminal
summary need a clean rerun in an environment whose terminal bridge retains
long-running child-process completion output.

## Recommended next steps

Run `npm run verify:fast`, the elevated Floor 6 HUD E2E, and
`npm run verify:pr-prereqs`; then perform the required fresh Ducky review and
publish a ready-for-review PR if all gates pass.
