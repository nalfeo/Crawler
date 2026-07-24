# Handoff — Player Session Recorder

**Date:** 2026-06-23  
**Persona:** Producer (multi-layer: game + engine + labs + tests)  
**Branch:** current copilot branch

---

## What Was Done

Added a dev-only player session recorder so human play can be captured at the same telemetry fidelity as the AI headless runner. The data can be used to compare human vs AI behavior and tune AI parameters.

### Files Created / Modified

| File                                         | Change                                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/session-recorder-types.ts`       | NEW — `SessionRecorder` + `SessionRecorderStats` interfaces. Lives in shared so `src/engine/` can reference them without violating layer rules.                                                                                                                                                 |
| `src/game/ai/player-session-recorder.ts`     | NEW — `PlayerSessionEvent` (extends `SimEvent` + raw input fields), `createPlayerSessionRecorder()` factory. Records per-frame samples, state transitions, kills, levelups, quest events. Infers behavioral state from input signals so `summarizeEvents()` works on human data.                |
| `src/engine/scenes/MainGameScene.ts`         | MODIFIED — Added `sessionRecorderFactory` option (dependency-injected factory, engine never imports game). Added `Enemy`/`query` imports. Wired kill detection (enemy count delta), levelup detection, per-step `tick()` in the sim loop. Exposes recorder as `window.__playerSessionRecorder`. |
| `src/labs/session-recorder-lab/index.ts`     | NEW — Full playable lab. Factory-injects the recorder into the scene. Controls: Download JSONL, Show Summary, Copy JSONL, Reset. Status ticker logs event counts every 2s.                                                                                                                      |
| `src/lab-main.ts`                            | MODIFIED — Registered `session-recorder-lab`.                                                                                                                                                                                                                                                   |
| `tests/game/player-session-recorder.test.ts` | NEW — 18 unit tests covering sampling cadence, input capture, kill/levelup/quest/npc events, health/level reads, JSONL serialization, reset, quest log tracking.                                                                                                                                |

### Architecture Decisions

- **Dependency injection via factory** — `MainGameScene` takes `sessionRecorderFactory?: (world, playerEid) => SessionRecorder`. The engine never imports from `src/game/`, keeping layer boundaries intact.
- **Shared interface** — `SessionRecorder` in `src/shared/session-recorder-types.ts` is the engine-visible contract. `PlayerSessionRecorder` in game layer extends it with typed event access.
- **Same format as AI runs** — `PlayerSessionEvent extends SimEvent`, so `summarizeEvents()`, `eventsToJsonl()`, and all existing analysis tools work unchanged on human sessions.
- **Behavioral state inference** — `inferHumanState()` maps raw input signals to the same `AI_STATE_NAME` vocabulary (EXPLORE/ENGAGE/COLLECT/IDLE) so state-time breakdowns are comparable.

---

## Apples

- **Estimated:** 🍎🍎🍎 (Medium)
- **Actual:** 🍎🍎🍎 (Medium) — new module, shared interface, engine wiring, lab, 18 tests; ~6 files, no ADR needed
- **Verdict:** ✅ Calibrated

---

## Systems touched

devtools

## Agent-OS Telemetry

_No guard telemetry artifact was captured in this session._

---

## Next Steps / Known Gaps

- **No main.ts wiring** — the main game entry doesn't expose a way to enable recording for end users. A keyboard shortcut or URL param (`?record=1`) could be added later.
- **Quest events are auto-tracked from `world.questLog`** in `tick()` — no separate `onQuestEvent` calls needed from the scene for quest-log quests. Floor1-specific `mainQuestAcceptedMs` tracking is not wired (could add if needed).
- **No `onNpcEvent` calls from scene** — the NPC interaction hook in `MainGameScene` could call `recorder.onNpcEvent()` when dialogues start, but it's minor and omitted to keep the scene change minimal.
