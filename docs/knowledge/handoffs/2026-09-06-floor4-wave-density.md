# Session Handoff: Floor 4 Wave Density

## Date

2026-09-06

## Persona

Producer

## Systems touched

floor4-arena

## Apples

1-2🍎 estimated, 1🍎 actual (over: the planned cadence-only manifest change
required no runtime-system edits or new test infrastructure).

## Verdict

Recommended. Reducing the authored Floor 4 wave interval from 12 seconds to 9
seconds increases combat continuity without changing wave budgets, live caps,
spawn debt caps, or director sequencing.

## Changes

- Set `floor4.waves.cadence.intervalMs` to `9000` in
  `src/shared/data/floors/floor4.manifest.json`.
- Added a focused manifest regression assertion for the 9-second cadence in
  `tests/unit/floor4-wave-manifest.test.ts`.

## Evidence

The real headless Floor 4 wave and completion tests were run after the change.
The director continues to enforce the authored live cap of 24 and debt cap of
18; the existing unit coverage exercises both bounds. No secondary increase to
waves per act or live cap was needed.
