# Handoff — Merge session recorder into Floor 1 & AI runner labs

**Date:** 2026-06-23
**Branch:** `nalfeo-merge-recorder-into-labs`
**Apples:** estimated 🍎🍎 / actual 🍎🍎 — calibrated

## Systems touched

devtools

## What changed

The standalone `session-recorder-lab` was removed. Its recording UI + scene
wiring now mounts directly into the labs where the Floor 1 scenario actually
runs, so a separate lab is no longer needed.

| File                                    | Change                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/labs/session-recorder-controls.ts` | NEW — shared `createSessionRecorderControls()` helper. Exposes `factory` (inject as `MainGameScene` `sessionRecorderFactory`), a persistent panel `element`, `mount(container)`, and `destroy()`. Panel has Download JSONL / Show Summary / Copy JSONL / Reset + a 2s status ticker, identical behavior to the old lab. |
| `src/labs/floor1-lab/index.ts`          | Creates a recorder, injects `sessionRecorderFactory` into the `MainGameScene` options, mounts the panel into `controls`, destroys it on teardown. Records human play.                                                                                                                                                   |
| `src/labs/ai-runner-lab/index.ts`       | Same wiring into its `sceneOptions`. Added an `#ai-recorder-host` div to the controls template; `renderControls()` re-`mount()`s the persistent panel after each `innerHTML` rebuild (log survives re-renders). Records AI play.                                                                                        |
| `src/lab-main.ts`                       | Removed the `session-recorder-lab` registration.                                                                                                                                                                                                                                                                        |
| `src/labs/session-recorder-lab/`        | DELETED.                                                                                                                                                                                                                                                                                                                |
| `tests/game/ai-scoring.test.ts`         | Pre-existing prettier formatting fix (incidental).                                                                                                                                                                                                                                                                      |

## Notes

- The recorder module itself (`src/game/ai/player-session-recorder.ts`) and its
  tests are unchanged — only the lab-side wiring moved.
- `session-recorder-controls.ts` is intentionally not an `index.ts`, so the lab
  auto-loader (`import.meta.glob('/src/labs/**/index.ts')`) does not treat it as
  a lab and it never calls `registerLab`.

## Validation

- `npm run verify` (full suite) — PASS (typecheck, lint, format, unit,
  integration, headless Floor 1 gate, build).
- `scripts/agent/lab-gate-check.sh` — PASS.

## Follow-ups

- None required. To record a session: open `?lab=floor1-lab` (human) or
  `?lab=ai-runner` (AI) and use the Session Recorder panel in the controls.
