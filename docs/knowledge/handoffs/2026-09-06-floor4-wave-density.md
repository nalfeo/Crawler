# Session Handoff: Floor 4 Wave Density

## Date

2026-09-06

## Persona

Producer

## Systems touched

floor4-arena

## Apples

1-2🍎 estimated, 2🍎 actual (exact: the authored cadence and wave-count change
required no runtime-system edits or new test infrastructure).

## Verdict

Recommended. Reducing the authored Floor 4 wave interval from 12 seconds to 9
seconds while adding two waves per act increases combat continuity without
changing wave budgets, live caps, spawn debt caps, or director sequencing.

## Changes

- Set `floor4.waves.cadence` to 10 waves per act at a `9000` ms interval in
  `src/shared/data/floors/floor4.manifest.json`.
- Added focused manifest regression assertions for the 9-second cadence and a
  final release no more than one interval before the wave window ends in
  `tests/unit/floor4-wave-manifest.test.ts`.

## Evidence

The real headless Floor 4 wave and completion tests were run after the change.
The director continues to enforce the authored live cap of 24 and debt cap of
18; the existing unit coverage exercises both bounds. The final wave now
releases at 81 seconds, leaving a 9-second tail instead of the prior 27-second
tail.
