# Handoff — AI runner lighting panel

## Date

2026-06-28

## Persona(s) adopted

Game Designer.

## Routing verdict

✅ right persona — lab UX/tuning work on an existing gameplay-debug surface.

## Apples

Estimated: 🍎 x 2
Actual: 🍎 x 2
Verdict: 🎯 Exact — one lab wiring change plus one focused regression guard.

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

ai-combat-balance, lighting

## What Was Done

- Added a lil-gui `Lighting` folder to `src/labs/ai-runner-lab/index.ts`.
- Wired the panel to `window.__floor1Debug.lighting` so the AI runner lab can tune:
  - step size
  - ambient light
  - source radius
  - source intensity
  - falloff
  - blur/softness
  - update cadence
  - auto-quality toggle
  - target compute budget
- Added lighting presets (tile / half tile / quarter tile / 1px).
- Persisted lighting settings and the flow-field toggle with lab session storage.
- Preserved the lil-gui DOM by rendering the AI runner’s custom HTML controls into a dedicated panel root instead of replacing the entire controls container.
- Added `tests/unit/ai-runner-lighting-controls.test.ts` to guard the lighting panel wiring and reseed reapply hook.

## Observe Before Done

- Before: the AI runner lab exposed only its custom HTML controls; there was no dedicated lighting tuning folder on the lab surface.
- After: runtime check against `http://127.0.0.1:4173/lab.html?lab=ai-runner` showed the `Lighting` folder with preset, ambient, radius, intensity, falloff, cadence, and perf controls visible in the lab controls panel.

## Validation

- `npx vitest run tests/unit/ai-runner-lighting-controls.test.ts tests/unit/ai-level-up-ux-wiring.test.ts tests/unit/ai-shopkeeper-ux-wiring.test.ts tests/unit/main-game-scene-lighting-overlay.test.ts tests/unit/main-game-scene-simulation-pause.test.ts tests/unit/labs/ai-runner-path-overlay.test.ts` ✅
- `npm run verify:fast` ✅
- `bash scripts/agent/lab-gate-check.sh` ✅
- `npm run verify` ✅
- `parallel_validation` ✅ CodeQL found 0 alerts
- `parallel_validation` ⚠️ final rerun hit the session time limit after earlier review feedback was addressed; remaining review suggestion was to add a heavier runtime/integration test for reseed lighting restore.

## Unresolved / Follow-up

- Optional: add a fuller integration-style test around AI runner reseed + lighting restore if the lab gains a lightweight test harness for Phaser/lab runtime behavior.

## Branch State

- Branch: `copilot/add-light-tuning-panel`
- Guard telemetry file present: no
