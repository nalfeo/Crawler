# Handoff — AI runner manual pause / takeover

**Date:** 2026-06-25
**Persona:** AI Content Engineer (recorder + AI runner lab)
**Apples:** estimated 🍎🍎🍎 / actual 🍎🍎🍎 (🎯 exact)

## Systems touched

ai-combat-balance

## Task

Add the ability to pause an AI runner session and play it manually, and make
the session recorder clearly mark when manual play happens.

## Change

The AI brain pause is orthogonal to the existing simulation `isPaused` flag:
instead of freezing the sim, we swap the input source from the AI brain to real
hardware (keyboard/mouse/touch) and suppress AI auto-driving while a human plays.
The recorder gained a first-class notion of _who is driving_.

- `src/game/ai/event-log.ts`
  - Added `'control'` to the `SimEventType` union.
- `src/shared/session-recorder-types.ts`
  - Added `SessionController` (`'AI' | 'MANUAL'`), a `controller` field on
    `SessionRecorderStats`, and an `onControlChange(controller, note?)` method on
    the `SessionRecorder` interface.
- `src/game/ai/player-session-recorder.ts`
  - Every `PlayerSessionEvent` is now tagged with the active `controller`.
  - New `initialController` option (default `'MANUAL'`, so the human-only Floor 1
    lab needs no change); the AI runner passes `'AI'`.
  - `onControlChange` is a no-op when unchanged, else pushes a clearly-labeled
    `control` event (`state = controller`, `reason = 'control-change'`).
  - `reset()` now **preserves** the live controller (it only clears the event
    log/counters) — clearing the log must not silently re-tag who is driving.
- `src/labs/session-recorder-controls.ts`
  - Forwards `initialController`, surfaces `control=<controller>` in the status
    ticker, and logs a 🎮 MANUAL / 🤖 AI banner on `onControlChange`.
- `src/labs/ai-runner-lab/index.ts`
  - New "🎮 Take manual control / 🤖 Return to AI" toggle. When manual:
    `aiInputProvider.poll` reads a real `createInputCapture(scene)` instead of
    `ai.poll`; `aiAutoDriverSystem` + `autoAdvanceSceneUi` early-return; the AI
    path overlay is cleared; Space-to-step is disabled (Space is attack).
  - Hardware capture is lazily created and disposed on return-to-AI, reseed, and
    teardown. `manualControl` is exposed on the debug snapshot.
- `tests/game/player-session-recorder.test.ts`
  - Added a `controller tracking` block (7 tests): default MANUAL, honored
    `initialController`, control event emitted/labeled, custom note, no-op when
    unchanged, samples re-tagged after handover, and **reset preserves the live
    controller**.

## Why this approach

The recorder is the same `PlayerSessionRecorder` whether the AI or a human drives
— it just records whatever `inputState` it is handed. Previously it could not
distinguish the two. The new `controller` tag + `control` event make AI-vs-MANUAL
segments explicit in the recording, which is the whole point of the request.
Routing manual input through the existing `inputCaptureOverride` channel means
the scene's own human key handling (E/B/1/2/3/I/G/ESC) "just works" with no
scene changes.

## Code review follow-up (fixed)

A `code-review` pass caught a desync: the recorder panel's `🗑 Reset` button
called `recorder.reset()`, which used to revert `currentController` to
`initialController` (`'AI'`). Resetting mid-manual-play would then silently tag
subsequent human input as `'AI'`. Fixed by making `reset()` preserve the live
controller (the owning lab is the sole authority via `onControlChange`), with a
dedicated regression test.

## Validation

- `npx vitest run tests/game/player-session-recorder.test.ts` (25 passed)
- `npm run verify:fast`
- `npm run verify` (full suite)
- `bash scripts/agent/lab-gate-check.sh` (no new ECS systems)

## Follow-ups / notes

- **Known limitation (scoped out):** `autoLevelUpAllocator` stays wired during
  manual play, so a level-up briefly auto-resolves the stat allocation and play
  continues. Non-disruptive for a dev affordance; left out to keep this a clean
  🍎🍎🍎. A future pass could surface the level-up modal to the human while in
  manual control.
- `files/guard-telemetry.jsonl` was not present in this session, so no guard
  telemetry section was added.
