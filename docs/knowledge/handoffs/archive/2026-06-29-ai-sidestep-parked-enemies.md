# Handoff — AI sidesteps enemies parked on the quest beeline

## Persona

AI Content Engineer (path `src/game/ai/**`), Systems-leaning nav fix.

## Apples

Estimated 🍎🍎🍎 (Medium) — repro a reported seed, surgical change to the runner's
threat-avoidance, regression test. Actual 🍎🍎 — two files, one focused steering
branch + tests. Verdict: 📈 over (cleaner than expected; existing dodge plumbing
just needed a second trigger).

## Problem

Seed 755884 (and others) charged straight through enemies while beelining to
quest objectives even when a trivial sidestep was available, eating contact
damage. `OpportunisticDodge` only fired when an enemy was _closing fast_
(≥0.15 ft/frame), so a stationary/slow mob parked on the path was bulldozed.

## Fix

`buildOpportunisticDodge` (`src/game/ai/bt-ai-provider.ts`) now also triggers a
path-blocking sidestep: an enemy within `DODGE_BLOCK_RADIUS_FT` (6 ft) and inside
the forward travel cone (`DODGE_BLOCK_AHEAD_DOT` 0.4) draws a perpendicular dodge
toward the open side regardless of closing speed. Heading comes from the Track A
target (fallback: smoothed move). Closing-speed dodge is unchanged; suspended in
ENGAGE/RETREAT/INTERACT as before.

## Evidence (deterministic probe, EXPLORE + enemy dead-ahead ≤3.5ft, no dodge)

| seed   | before | after |
| ------ | ------ | ----- |
| 755884 | 124    | 36    |
| 1      | 137    | 24    |
| 42     | 106    | 31    |

Win-rate sweep + `npm run verify` (incl. headless) green. Added 2 regression
tests (stationary blocker ahead sidesteps; behind = no dodge), 37 BT tests pass.

## Next

Residual contacts are mostly the final approach as Track A flips to ENGAGE
(dodge correctly suspended). Could promote a headless charge-through assertion if
it recurs.
