# Handoff: Floor 1 collapse timer

## Date

2026-07-03

## Persona

Game Designer - single-floor tuning change to improve human-run pacing.

## Apples

Estimated: 1 apple  
Actual: 1 apple  
Verdict: Exact - one data value plus focused expectations/documentation.

Hello kitties: 0.20

## What changed

- Raised Floor 1's manifest collapse timer from 360,000 ms to 600,000 ms (10 minutes).
- Updated the Floor 1 config unit expectation to lock the new timer.
- Clarified the headless completion gate comments: the AI still has to clear within the stricter 6-minute budget, while the player-facing collapse timer comes from the manifest.

## Observe before done

- Before: the Floor 1 manifest had `timer.durationMs: 360000` (6 minutes).
- After: the runtime config source reports `{"floor":"floor1","durationMs":600000,"minutes":10}`.

## Validation

- `npm run verify:fast` passed.

## Guard telemetry

No `files/guard-telemetry.jsonl` artifact was present for this session.
