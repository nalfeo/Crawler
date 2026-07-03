# Handoff: Floor 1 collapse timer

## Date

2026-07-03

## Persona

Game Designer - single-floor tuning change to improve human-run pacing.

## Apples

Estimated: 1 apple  
Actual: 2 apples  
Verdict: Under - review follow-up added an explicit AI panic-deadline decouple plus tests.

Hello kitties: 0.40

## What changed

- Raised Floor 1's manifest collapse timer from 360,000 ms to 600,000 ms (10 minutes).
- Updated the Floor 1 config unit expectation to lock the new timer.
- Clarified the headless completion gate comments: the AI still has to clear within the stricter 6-minute budget, while the player-facing collapse timer comes from the manifest.
- Added an AI-only 6-minute collapse-panic deadline so BT panic/beeline behavior does not drift when the human-facing Floor 1 timer changes.
- Added deterministic panic-profile coverage proving the AI beeline threshold still fires inside the 6-minute gate while the manifest timer is 10 minutes.

## Observe before done

- Before: the Floor 1 manifest had `timer.durationMs: 360000` (6 minutes).
- After: the runtime config source reports `{"floor":"floor1","durationMs":600000,"minutes":10}`.
- PR review follow-up: with the 10-minute player timer, the sampled gated win-rate was sword 7/8, bow 8/8, baseball-bat 8/8 before decoupling. The final implementation pins AI panic pressure to a 6-minute deadline independent of the manifest timer, and the post-fix sample remained sword 7/8, bow 8/8, baseball-bat 8/8.

## Validation

- `npm run verify:fast` passed.
- `VERIFY_FULL=1 npm run verify` passed.
- `npm run ai:winrate-sweep -- --seeds 1-8 --weapons sword,bow,baseball-bat --max-frames 23760` produced sword 7/8, bow 8/8, baseball-bat 8/8 before the decoupling patch.
- `npm test -- tests/unit/ai-collapse-panic-profile.test.ts tests/game/behavior-tree-ai.test.ts` passed after the decoupling patch.
- Post-fix `npm run ai:winrate-sweep -- --seeds 1-8 --weapons sword,bow,baseball-bat --max-frames 23760` produced sword 7/8, bow 8/8, baseball-bat 8/8.

## Guard telemetry

No `files/guard-telemetry.jsonl` artifact was present for this session.
