# Session Handoff: Lighting granularity from tile-size to 1px

## Date

2026-06-27

## Persona(s) adopted

Producer + Systems Engineer + UX Designer + QA Engineer (cross-layer lighting/render/lab/test work).

## Routing verdict

✅ right persona — multi-layer feature needed orchestration.

## Apples

Estimated: 🍎 x 4
Actual: 🍎 x 4
Verdict: 🎯 Exact — feature required coordinated core-map usage, engine rendering, lab controls, and tests.

Hello kitties: 4/5 = 0.80 🎀

## Systems touched

lighting

## What Was Done

- Added `src/engine/lighting/light-field.ts` with configurable multi-resolution light buffers (`stepPx`), presets, dirty-rect support, occlusion-aware lighting compute, optional blur, and auto step fallback helpers.
- Integrated dynamic darkness overlay into `src/engine/scenes/MainGameScene.ts`:
  - New RenderTexture layer above terrain.
  - Live config/preset API exposed at `window.__floor1Debug.lighting`.
  - Auto quality fallback when compute time exceeds budget.
- Upgraded `src/labs/fov-lab/index.ts` into FOV + lighting tuning lab with controls:
  - `stepPx`, ambient, falloff curve, blur/softness, radius, intensity.
  - Continuous FPS/frame-time/lighting-compute telemetry.
- Added tests:
  - `tests/unit/light-field.test.ts`
  - `tests/ecs/light-field-integration.test.ts`

## What's Next

- If desired, add authored world light sources beyond player light (e.g. torches/projectiles) using the same light-field path.
- Add explored-memory fog-of-war state separate from current visibility for richer darkness transitions.

## Blockers

None.

## Branch State

- Branch: `copilot/design-lighting-and-shadow-system`
- All tests passing: yes
- PR created: no

## Agent-OS Telemetry

No `files/guard-telemetry.jsonl` present in this session.

## Test Results

- `npm run verify:fast` ✅
- `npm run verify` ✅
- `parallel_validation` ✅ (Code Review + CodeQL, no findings)

## Key Decisions Made

- Kept gameplay gating on tile-based FOV/LOS while moving visual shading to a separate configurable light-field.
- Implemented performance guardrails with update throttling support + auto step-up fallback.
